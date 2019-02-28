// @flow

import {Resolver} from '@parcel/plugin';
import type {CLIOptions, Dependency, PackageJSON} from '@parcel/types';
import path from 'path';
import fs from '@parcel/fs';
import {glob} from '@parcel/utils';
import micromatch from 'micromatch';
import builtins from './builtins';
// import nodeBuiltins from 'node-libs-browser';

export default new Resolver({
  async resolve(dep: Dependency, cli: CLIOptions, rootDir: string) {
    const resolved = await new NodeResolver({
      extensions: ['js', 'json', 'css'],
      cli,
      rootDir
    }).resolve(dep);

    return resolved ? resolved.path : null;
  }
});

type InternalPackageJSON = PackageJSON & {
  pkgdir: string
};

const EMPTY_SHIM = require.resolve('./_empty');

type Options = {
  cli: CLIOptions,
  rootDir: string,
  extensions: Array<string>
};

/**
 * This resolver implements a modified version of the node_modules resolution algorithm:
 * https://nodejs.org/api/modules.html#modules_all_together
 *
 * In addition to the standard algorithm, Parcel supports:
 *   - All file extensions supported by Parcel.
 *   - Glob file paths
 *   - Absolute paths (e.g. /foo) resolved relative to the project root.
 *   - Tilde paths (e.g. ~/foo) resolved relative to the nearest module root in node_modules.
 *   - The package.json module, jsnext:main, and browser field as replacements for package.main.
 *   - The package.json browser and alias fields as an alias map within a local module.
 *   - The package.json alias field in the root package for global aliases across all modules.
 */
class NodeResolver {
  options: Options;
  packageCache: Map<string, InternalPackageJSON>;
  rootPackage: InternalPackageJSON | null;

  constructor(options: Options) {
    this.options = Object.assign({}, options, {
      // normalize extensions that don't lead with '.'
      extensions: options.extensions.map(
        ext => (ext.startsWith('.') ? ext : '.' + ext)
      )
    });
    this.packageCache = new Map();
    this.rootPackage = null;
  }

  async resolve({
    moduleSpecifier: filename,
    sourcePath: parent,
    isURL
  }: Dependency) {
    // Check if this is a glob
    if (glob.isGlob(filename)) {
      return {path: path.resolve(path.dirname(parent), filename)};
    }

    // Get file extensions to search
    let extensions: Array<string> = Array.isArray(this.options.extensions)
      ? this.options.extensions.slice()
      : Object.keys((this.options: any).extensions);

    if (parent) {
      // parent's extension given high priority
      let parentExt = path.extname(parent);
      extensions = [parentExt, ...extensions.filter(ext => ext !== parentExt)];
    }

    extensions.unshift('');

    // Resolve the module directory or local file path
    let module = await this.resolveModule(filename, parent, isURL);

    if (module.moduleDir) {
      return this.loadNodeModules(module, extensions);
    } else if (module.filePath) {
      return this.loadRelative(module.filePath, extensions);
    } else {
      return null;
    }
  }

  async resolveModule(filename, parent, isURL) {
    let dir = parent ? path.dirname(parent) : process.cwd();

    // If this isn't the entrypoint, resolve the input file to an absolute path
    if (parent) {
      filename = this.resolveFilename(filename, dir, isURL);
    }

    // Resolve aliases in the parent module for this file.
    filename = await this.loadAlias(filename, dir);

    // Return just the file path if this is a file, not in node_modules
    if (path.isAbsolute(filename)) {
      return {
        filePath: filename
      };
    }

    // Resolve the module in node_modules
    let resolved;
    try {
      resolved = await this.findNodeModulePath(filename, dir);
    } catch (err) {
      // ignore
    }

    // If we couldn't resolve the node_modules path, just return the module name info
    if (!resolved) {
      let parts = this.getModuleParts(filename);
      resolved = {
        moduleName: parts[0],
        subPath: parts[1]
      };
    }

    return resolved;
  }

  getCacheKey(filename, parent) {
    return (parent ? path.dirname(parent) : '') + ':' + filename;
  }

  resolveFilename(filename: string, dir: string, isURL: ?boolean) {
    switch (filename[0]) {
      case '/':
        // Absolute path. Resolve relative to project root.
        return path.resolve(this.options.rootDir, filename.slice(1));

      case '~':
        // Tilde path. Resolve relative to nearest node_modules directory,
        // or the project root - whichever comes first.
        while (
          dir !== this.options.rootDir &&
          path.basename(path.dirname(dir)) !== 'node_modules'
        ) {
          dir = path.dirname(dir);

          if (dir === path.dirname(dir)) {
            dir = this.options.rootDir;
            break;
          }
        }

        return path.join(dir, filename.slice(1));

      case '.':
        // Relative path.
        return path.resolve(dir, filename);

      default:
        if (isURL) {
          return path.resolve(dir, filename);
        }

        // Module
        return filename;
    }
  }

  async loadRelative(filename: string, extensions: Array<string>) {
    // Find a package.json file in the current package.
    let pkg = await this.findPackage(path.dirname(filename));

    // First try as a file, then as a directory.
    return (
      (await this.loadAsFile(filename, extensions, pkg)) ||
      (await this.loadDirectory(filename, extensions, pkg))
    );
  }

  async findNodeModulePath(filename: string, dir: string) {
    if (builtins[filename]) {
      // if (this.options.cli.target === 'node' && filename in nodeBuiltins) {
      //   throw new Error('Cannot resolve builtin module for node target');
      // }

      return {filePath: builtins[filename]};
    }

    let parts = this.getModuleParts(filename);
    let root = path.parse(dir).root;

    while (dir !== root) {
      // Skip node_modules directories
      if (path.basename(dir) === 'node_modules') {
        dir = path.dirname(dir);
      }

      try {
        // First, check if the module directory exists. This prevents a lot of unnecessary checks later.
        let moduleDir = path.join(dir, 'node_modules', parts[0]);
        let stats = await fs.stat(moduleDir);
        if (stats.isDirectory()) {
          return {
            moduleName: parts[0],
            subPath: parts[1],
            moduleDir: moduleDir,
            filePath: path.join(dir, 'node_modules', filename)
          };
        }
      } catch (err) {
        // ignore
      }

      // Move up a directory
      dir = path.dirname(dir);
    }
  }

  async loadNodeModules(module, extensions: Array<string>) {
    try {
      // If a module was specified as a module sub-path (e.g. some-module/some/path),
      // it is likely a file. Try loading it as a file first.
      if (module.subPath) {
        let pkg = await this.readPackage(module.moduleDir);
        let res = await this.loadAsFile(module.filePath, extensions, pkg);
        if (res) {
          return res;
        }
      }

      // Otherwise, load as a directory.
      return await this.loadDirectory(module.filePath, extensions);
    } catch (e) {
      // ignore
    }
  }

  async isFile(file) {
    try {
      let stat = await fs.stat(file);
      return stat.isFile() || stat.isFIFO();
    } catch (err) {
      return false;
    }
  }

  async loadDirectory(
    dir: string,
    extensions: Array<string>,
    pkg: InternalPackageJSON | null = null
  ) {
    try {
      pkg = await this.readPackage(dir);

      // Get a list of possible package entry points.
      let entries = this.getPackageEntries(pkg);

      for (let file of entries) {
        // First try loading package.main as a file, then try as a directory.
        const res =
          (await this.loadAsFile(file, extensions, pkg)) ||
          (await this.loadDirectory(file, extensions, pkg));
        if (res) {
          return res;
        }
      }
    } catch (err) {
      // ignore
    }

    // Fall back to an index file inside the directory.
    return await this.loadAsFile(path.join(dir, 'index'), extensions, pkg);
  }

  async readPackage(dir: string): Promise<InternalPackageJSON> {
    let file = path.join(dir, 'package.json');
    let cached = this.packageCache.get(file);

    if (cached) {
      return cached;
    }

    let json = await fs.readFile(file, 'utf8');
    let pkg = JSON.parse(json);

    pkg.pkgfile = file;
    pkg.pkgdir = dir;

    // If the package has a `source` field, check if it is behind a symlink.
    // If so, we treat the module as source code rather than a pre-compiled module.
    if (pkg.source) {
      let realpath = await fs.realpath(file);
      if (realpath === file) {
        delete pkg.source;
      }
    }

    this.packageCache.set(file, pkg);
    return pkg;
  }

  getBrowserField(pkg: InternalPackageJSON) {
    // let target = this.options.cli.target || 'browser';
    let target = 'browser';
    return target === 'browser' ? pkg.browser : null;
  }

  getPackageEntries(pkg: InternalPackageJSON) {
    let browser = this.getBrowserField(pkg);
    if (browser && typeof browser === 'object' && browser[pkg.name]) {
      browser = browser[pkg.name];
    }

    // libraries like d3.js specifies node.js specific files in the "main" which breaks the build
    // we use the "browser" or "module" field to get the full dependency tree if available.
    // If this is a linked module with a `source` field, use that as the entry point.
    return [pkg.source, browser, pkg.module, pkg.main]
      .filter(entry => typeof entry === 'string')
      .map(main => {
        // Default to index file if no main field find
        if (!main || main === '.' || main === './') {
          main = 'index';
        }

        if (typeof main !== 'string') {
          throw new Error('invariant: expected string');
        }

        return path.resolve(pkg.pkgdir, main);
      });
  }

  async loadAsFile(
    file: string,
    extensions: Array<string>,
    pkg: InternalPackageJSON | null
  ) {
    // Try all supported extensions
    for (let f of this.expandFile(file, extensions, pkg)) {
      if (await this.isFile(f)) {
        return {path: f, pkg};
      }
    }
  }

  expandFile(
    file: string,
    extensions: Array<string>,
    pkg: InternalPackageJSON | null,
    expandAliases = true
  ) {
    // Expand extensions and aliases
    let res = [];
    for (let ext of extensions) {
      let f = file + ext;

      if (expandAliases) {
        let alias = this.resolveAliases(file + ext, pkg);
        if (alias !== f) {
          res = res.concat(this.expandFile(alias, extensions, pkg, false));
        }
      }

      res.push(f);
    }

    return res;
  }

  resolveAliases(filename: string, pkg: InternalPackageJSON | null) {
    // First resolve local package aliases, then project global ones.
    return this.resolvePackageAliases(
      this.resolvePackageAliases(filename, pkg),
      this.rootPackage
    );
  }

  resolvePackageAliases(filename: string, pkg: InternalPackageJSON | null) {
    if (!pkg) {
      return filename;
    }

    // Resolve aliases in the package.source, package.alias, and package.browser fields.
    return (
      this.getAlias(filename, pkg.pkgdir, pkg.source) ||
      this.getAlias(filename, pkg.pkgdir, pkg.alias) ||
      this.getAlias(filename, pkg.pkgdir, this.getBrowserField(pkg)) ||
      filename
    );
  }

  getAlias(filename, dir, aliases) {
    if (!filename || !aliases || typeof aliases !== 'object') {
      return null;
    }

    let alias;

    // If filename is an absolute path, get one relative to the package.json directory.
    if (path.isAbsolute(filename)) {
      filename = path.relative(dir, filename);
      if (filename[0] !== '.') {
        filename = './' + filename;
      }

      alias = this.lookupAlias(aliases, filename, dir);
    } else {
      // It is a node_module. First try the entire filename as a key.
      alias = this.lookupAlias(aliases, filename, dir);
      if (alias == null) {
        // If it didn't match, try only the module name.
        let parts = this.getModuleParts(filename);
        alias = this.lookupAlias(aliases, parts[0], dir);
        if (typeof alias === 'string') {
          // Append the filename back onto the aliased module.
          alias = path.join(alias, ...parts.slice(1));
        }
      }
    }

    // If the alias is set to `false`, return an empty file.
    if (alias === false) {
      return EMPTY_SHIM;
    }

    return alias;
  }

  lookupAlias(aliases, filename, dir) {
    // First, try looking up the exact filename
    let alias = aliases[filename];
    if (alias == null) {
      // Otherwise, try replacing glob keys
      for (let key in aliases) {
        let val = aliases[key];
        if (typeof val === 'string' && glob.isGlob(key)) {
          let re = micromatch.makeRe(key, {capture: true});
          if (re.test(filename)) {
            alias = filename.replace(re, val);
            break;
          }
        }
      }
    }

    if (typeof alias === 'string') {
      return this.resolveFilename(alias, dir);
    }

    return typeof alias === 'string' ? alias : null;
  }

  async findPackage(dir: string) {
    // Find the nearest package.json file within the current node_modules folder
    let root = path.parse(dir).root;
    while (dir !== root && path.basename(dir) !== 'node_modules') {
      try {
        return await this.readPackage(dir);
      } catch (err) {
        // ignore
      }

      dir = path.dirname(dir);
    }

    return null;
  }

  async loadAlias(filename: string, dir: string) {
    // Load the root project's package.json file if we haven't already
    if (!this.rootPackage) {
      this.rootPackage = await this.findPackage(this.options.rootDir);
    }

    // Load the local package, and resolve aliases
    let pkg = await this.findPackage(dir);
    return this.resolveAliases(filename, pkg);
  }

  getModuleParts(name) {
    let parts = path.normalize(name).split(path.sep);
    if (parts[0].charAt(0) === '@') {
      // Scoped module (e.g. @scope/module). Merge the first two parts back together.
      parts.splice(0, 2, `${parts[0]}/${parts[1]}`);
    }

    return parts;
  }
}
