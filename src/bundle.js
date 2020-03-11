import path from "path";
import glob from "fast-glob";
import rollup from "rollup";
import yaml from "js-yaml";
import marked from "marked";
import Handlebars from "handlebars";

import { readHtml } from "./read-html";
import { readCss } from "./read-css";
import { rollupPlugins } from "./rollup/config-plugins";
import { createServer } from "./server";

import {
  asyncFs,
  readFile,
  writeFile,
  copyFile,
  asyncGroup,
  getRelativePath,
  getRelativeDeep,
  isMd,
  isJs,
  isCss,
  isHtml,
  isFixLink,
  isNotFixLink,
  normalizePath,
  streamLog,
  getPackage,
  createAwait
} from "./utils";

import { watch } from "./watch";

let defaultGroup = "Others";

const renderer = new marked.Renderer();
// add an additional container prevent the table from collapsing the page
renderer.table = (header, body) =>
  `<div class="markdown -table-container"><table>${header +
    body}</table></div>`;

//  configure the container to allow language to be highlighted independently of the class
renderer.code = (code, type) =>
  `<pre class="markdown -code-container" data-code="${type}"><code class="language-${type}">${Handlebars.Utils.escapeExpression(
    code
  )}</code></pre>`;

renderer.html = code => `<div class="markdown -html-container">${code}</div>`;

marked.setOptions({
  renderer
});

const toMarkdown = code => marked(code);

Handlebars.registerHelper("toJson", data => JSON.stringify(data || ""));

export default async function createBundle(options) {
  streamLog("loading...");
  let loadingStep = 3;
  const loadingInterval = setInterval(() => {
    if (server) return;
    loadingStep = loadingStep == 0 ? 3 : loadingStep;
    streamLog("loading" + ".".repeat(loadingStep--));
  }, 250);

  options = await formatOptions(options);

  let files = await glob(options.src);

  // groups all manipulated files, prevents files
  // that have not been modified from being regenerated
  const mapFiles = new Map();

  // define if a file has already been manipulated
  const isReady = file => mapFiles.has(file);

  // !isReady
  const isNotReady = file => !isReady(file);

  // define if a file is of type template
  const isTemplate = file => options.template == file;

  // !isTempalte
  const isNotTemplate = file => !isTemplate(file);

  // delete the file, for new manipulation or
  // regeneration without the given file
  const deleteFile = file => {
    mapFiles.delete(file);
    return file;
  };

  // add a file to the registry and prevent a manipulation
  // job on it if it is verified with isReady
  const takeFile = file => {
    mapFiles.set(file, {
      imported: []
    });
    return file;
  };

  // cache stat generated by adding a file
  // This is used by searches in exportable files with only isHtml type...
  const cacheStat = new Map();

  // get the name of the file at the destination
  const getLink = file => {
    let { name, ext } = path.parse(file);
    return isFixLink(ext)
      ? name + (isJs(ext) ? ".js" : isMd(ext) ? ".html" : ext)
      : "file-" +
          file.split("").reduce((out, i) => (out + i.charCodeAt(0)) | 8, 4) +
          ext;
  };
  // get the final destination name
  const getDest = (file, folder = "") => path.join(options.dest, folder, file);

  // returns folder retracements based on relative path depth

  // promise to be resolved if watch mode has been enabled
  // allows to wait for the watch to complete to add a
  // new file to the queue, for a new regeneration
  const awaitWatch = createAwait();

  // date of last build
  let lastTime = new Date();
  // group the watchers to clean between each build
  let watchers = [];

  // store the server, eg: server.reload()
  let server;

  let currentRollupCache;

  if (options.server) {
    server = await createServer({
      dest: options.dest,
      watch: options.watch,
      port: options.port
    });
    streamLog("");
    console.log(`\nserver running on http://localhost:${server.port}\n`);
  }

  clearInterval(loadingInterval);

  /**
   * regenerate the build
   * @param {string[]} files
   * @param {boolean} forceJs
   * @returns {Promise<void>}
   */
  async function readFiles(files, forceJs) {
    // normalize to avoid duplicates
    files = files.map(path.normalize);

    const addCurrentFiles = file => {
      if (!files.includes(file)) files.push(file);
      return file;
    };
    // check if one of the files is a template
    await asyncGroup(
      files
        .filter(isTemplate)
        .map(takeFile)
        .map(async file => {
          const template = mapFiles.get(file);
          const [code, meta] = getMetaFile(await readFile(file));

          if (meta.defaultGroup) {
            defaultGroup = meta.defaultGroup;
          }

          meta.groupOrder = []
            .concat(meta.groupOrder, defaultGroup)
            .reduce((map, title, position) => {
              let pages = new Map();
              if (typeof title == "object") {
                const [index] = Object.keys(title);
                pages = []
                  .concat(title[index])
                  .reduce(
                    (map, title, position) =>
                      map.set(title, { title, position }),
                    new Map()
                  );

                title = index;
              }

              return map.set(title, {
                position,
                pages,
                title
              });
            }, new Map());

          template.meta = meta;
          template.code = code;

          // before each file regeneration, the associates are restarted,
          // in this case those that comply with isHtml
          [...mapFiles]
            .map(([file]) => file)
            .filter(isHtml)
            .filter(isNotTemplate)
            .map(deleteFile)
            .forEach(addCurrentFiles);
        })
    );

    // ignore template files
    files = files.filter(isNotTemplate);

    // the html are of high hierarchy, since through them the
    // exportable ones are identified to work for the inferior porcesos
    let groupHtml = files
      .filter(isHtml)
      .filter(isNotReady)
      .map(takeFile)
      .map(async file => {
        const { dir } = path.parse(file);
        let [code, meta] = getMetaFile(await readFile(file));
        const relativeDeep = getRelativeDeep(meta.folder);
        const link = normalizePath(getLink(file));
        const dest = getDest(link, meta.folder);
        const group = [].concat(meta.group || defaultGroup);
        const page = { ...meta, group, file, dest, link };

        if (isMd(file)) {
          code = toMarkdown(code);
        }

        const nextCode = await readHtml({
          code,
          useFragment: options.template ? true : false,
          async addFile(childFile) {
            let findFile = path.join(dir, childFile);
            if (!cacheStat.has(findFile)) {
              let type = "local";
              try {
                await asyncFs.stat(findFile);
              } catch (e) {
                try {
                  // try to resolve the dependency from node_modules
                  findFile = require.resolve(childFile);
                  type = "external";
                } catch (e) {
                  type = "global";
                }
              }

              cacheStat.set(findFile, { type, file: findFile });

              if (options.watch && type == "local") {
                awaitWatch.promise.then(({ addFile }) => addFile(findFile));
              }
            }

            let state = cacheStat.get(findFile);

            if (state.type == "global") return childFile;

            addCurrentFiles(state.file);

            if (!mapFiles.get(file).imported.includes(state.file)) {
              mapFiles.get(file).imported.push(state.file);
            }

            return normalizePath(relativeDeep + getLink(state.file));
          }
        });

        // save the state of the page
        // to be used by getPages
        mapFiles.get(file).page = page;

        return {
          code: nextCode,
          page
        };
      });

    groupHtml = await asyncGroup(groupHtml);

    // write the html files, the goal of this being done separately,
    // is to group the pages before writing to metadata
    await asyncGroup(
      groupHtml.map(({ code, page }) => {
        let template;
        if (options.template) {
          template = mapFiles.get(options.template);
        }

        if (template) {
          const pages = getPages(
            page,
            // access all pages
            [...mapFiles]
              .filter(([file]) => !isTemplate(file) && isHtml(file))
              .map(([, { page }]) => page),
            template.meta.groupOrder
          );

          const pagination = {};

          pages.some(({ pages }) =>
            pages.some((item, i) => {
              if (item.file == page.file) {
                pagination.prev = pages[i - 1];
                pagination.next = pages[i + 1];
                return true;
              }
            })
          );

          const data = {
            theme: template.meta,
            page: { ...page, ...pagination },
            pages
          };
          code = Handlebars.compile(code)(data);

          if (page.template != false) {
            // The use of Partial generates an error in the printing of
            // the tabulation, so the content is associated as a variable
            code = Handlebars.compile(template.code)({
              ...data,
              page: { ...data.page, content: code }
            });
          }
        }

        writeFile(page.dest, code);
      })
    );
    // parallel task block
    await asyncGroup([
      asyncGroup(
        files
          .filter(isCss)
          .filter(isNotReady)
          .map(takeFile)
          .map(async file => {
            const code = await readFile(file);
            const nextCode = await readCss({
              file,
              code,
              minify: options.minify,
              browsers: options.browsers,
              addWatchFile(childFile) {
                if (options.watch) {
                  awaitWatch.promise.then(({ addFile }) =>
                    addFile(childFile, file)
                  );
                }
              }
            });
            return writeFile(getDest(getLink(file)), nextCode);
          })
      ),
      asyncGroup(
        files
          .filter(isNotFixLink)
          .filter(isNotReady)
          .map(takeFile)
          .map(async file => copyFile(file, getDest(getLink(file))))
      )
    ]);

    // Rollup only restarts if a new js has been added from external sources
    if (
      forceJs ||
      files
        .filter(isJs)
        .filter(isNotReady)
        .map(takeFile).length
    ) {
      watchers = watchers.filter(watcher => {
        watcher.close();
      });

      const input = {
        input: [...mapFiles].map(([file]) => file).filter(isJs),
        onwarn: streamLog,
        external: options.external,
        plugins: rollupPlugins(options),
        cache: currentRollupCache
      };

      const output = {
        dir: options.dest,
        format: "es",
        sourcemap: options.sourcemap,
        chunkFileNames: "chunks/[hash].js"
      };

      const bundle = await rollup.rollup(input);

      currentRollupCache = bundle.cache;

      if (options.watch) {
        const watcher = rollup.watch({
          ...input,
          output,
          watch: { exclude: "node_modules/**" }
        });

        watcher.on("event", async event => {
          switch (event.code) {
            case "START":
              lastTime = new Date();
              break;
            case "END":
              streamLog(`bundle: ${new Date() - lastTime}ms`);
              server && server.reload();
              break;
            case "ERROR":
              streamLog(event.error);
              break;
          }
        });

        watchers.push(watcher);
      }

      await bundle.write(output);
    } else {
      streamLog(`bundle: ${new Date() - lastTime}ms`);
      server && server.reload();
    }
  }
  try {
    await readFiles(files);

    if (options.watch) {
      const mapSubWatch = new Map();
      const isRootWatch = file =>
        mapSubWatch.has(file) ? !mapSubWatch.get(file).length : true;

      const watcher = watch(options.src, group => {
        let files = [];
        let forceJs;

        if (group.add) {
          let groupFiles = group.add
            .filter(isRootWatch)
            .filter(isFixLink)
            .filter(isNotReady);
          files = [...files, ...groupFiles];
        }
        if (group.change) {
          let groupChange = group.change;
          group.change
            .filter(file => mapSubWatch.has(file))
            .map(file => mapSubWatch.get(file))
            .reduce(
              (groupParent, groupChild) => groupParent.concat(groupChild),
              []
            )
            .forEach(file => {
              if (!groupChange.includes(file)) groupChange.push(file);
            });

          let groupFiles = groupChange
            .filter(file => isRootWatch(file) || isReady(file))
            .filter(isFixLink)
            .filter(file => !isJs(file))
            .map(deleteFile);

          files = [...files, ...groupFiles];
        }
        if (group.unlink) {
          if (
            group.unlink
              .filter(isJs)
              .filter(isReady)
              .map(deleteFile).length
          ) {
            forceJs = true;
          }
        }
        if (files.length || forceJs) {
          lastTime = new Date();
          readFiles(files, forceJs);
        }
      });
      awaitWatch.resolve({
        addFile(file, parentFile) {
          if (!mapSubWatch.has(file)) {
            mapSubWatch.set(file, []);
            watcher.add(file);
          }
          if (parentFile && !mapSubWatch.get(file).includes(parentFile)) {
            mapSubWatch.get(file).push(parentFile);
          }
        }
      });
    }
  } catch (e) {
    console.log(e);
  }
}

async function formatOptions({ src = [], config, external, ...ignore }) {
  const pkg = await getPackage();

  src = Array.isArray(src) ? src : src.split(/ *; */g);

  if (external) {
    external = Array.isArray(external)
      ? external
      : [true, "true"].includes(external)
      ? Object.keys(pkg.dependencies)
      : external.split(/ *, */);
  }

  external = [...(external || []), ...Object.keys(pkg.peerDependencies)];

  let options = {
    src,
    external,
    babel: pkg.babel,
    ...ignore,
    ...pkg[config]
  };

  if (options.template) {
    options.src.unshift((options.template = path.normalize(options.template)));
  }

  // normalize routes for fast-glob
  options.src = options.src.map(glob => glob.replace(/\\/g, "/"));

  return options;
}

export function getMetaFile(code) {
  let meta = {};
  code = code.replace(/---\s([.\s\S]*)\s---\s/, (all, content, index) => {
    if (!index) {
      meta = yaml.safeLoad(content);
      return "";
    }
    return all;
  });
  return [code, meta];
}
/**
 * generates a map of relative files to be used as a nav
 * @param {Page} page - page to build the menu
 * @param {Page[]} filesHtml - files as html page
 * @param {string[]} groupOrder  - allows you to sort the pages giving priority to the given list
 * @returns {[]}
 */
function getPages(page, filesHtml, groupOrder) {
  const link = normalizePath(path.join("./", page.folder || "", page.link));
  const pages = filesHtml.map(page => ({
    ...page,
    // pages are regenerated by each page since each one can exist in a different directory
    link: normalizePath(
      getRelativePath(link, path.join("./", page.folder || "", page.link))
    )
  }));

  const groups = pages.reduce(
    (map, page) =>
      page.group.reduce(
        (map, title) => map.set(title, [...(map.get(title) || []), page]),
        map
      ),
    new Map()
  );

  const sortByPosition = ([a], [b]) => (a > b ? 1 : -1);
  const formatGroup = ([, data]) => data;
  const formatPage = ([, { pages }]) => pages;

  const splitGroups = groupOrder => (
    [firstGroup, lastGroup],
    [title, pages]
  ) => {
    const group = groupOrder.get(title);
    if (group) {
      firstGroup.set(group.position, { title, pages });
    } else {
      lastGroup.set(title, { title, pages });
    }
    return [firstGroup, lastGroup];
  };

  const [firstGroup, lastGroup] = [...groups].reduce(splitGroups(groupOrder), [
    new Map(),
    new Map()
  ]);

  return [
    ...[...firstGroup]
      .sort(sortByPosition)
      .map(formatGroup)
      .map(({ title, pages }) => {
        const group = groupOrder.get(title);
        if (group.pages.size) {
          const [firstPages, lastPages] = pages
            .map(page => [page.title, page])
            .reduce(splitGroups(group.pages), [new Map(), new Map()]);

          pages = [
            ...[...firstPages].sort(sortByPosition).map(formatPage),
            ...[...lastPages].sort(sortByPosition).map(formatPage)
          ];
        }
        return { title, pages };
      }),
    ...[...lastGroup]
      .sort(sortByPosition)
      .map(formatGroup)
      .map(({ title, pages }) => ({
        title,
        pages: pages.sort((a, b) => (a.title > b.title ? 1 : -1))
      }))
  ];
}

/**
 * @typedef {{folder?:string,link:string,title?:string}} Page
 */
