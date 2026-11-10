'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

module.exports = function createPluginEngine(root, config, log) {
  const loaded = new Map();
  const pluginRoot = path.join(root, 'plugins');
  const dataRoot = path.join(root, 'config', 'plugins_data');

  function trustedPlugin(id) {
    const allowed = String(process.env.NODE_AI_WEB_TRUSTED_PLUGINS || '').split(',').map(x => x.trim()).filter(Boolean);
    return allowed.indexOf(id) !== -1;
  }

  function pluginDirectory(id) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      throw new Error('插件 ID 不合法。');
    }

    const directory = path.resolve(pluginRoot, id);
    if (!directory.startsWith(pluginRoot + path.sep)) {
      throw new Error('插件目录无效。');
    }

    try {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('插件目录不能是符号链接。');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return directory;
  }

  function load(id) {
    if (!trustedPlugin(id)) throw new Error('插件未加入 NODE_AI_WEB_TRUSTED_PLUGINS 白名单；VM 不是安全沙箱，只能加载完全可信代码。');
    const directory = pluginDirectory(id);
    const metadata = JSON.parse(
      fs.readFileSync(path.join(directory, 'plugin.json'), 'utf8')
    );
    const source = fs.readFileSync(path.join(directory, 'index.js'), 'utf8');
    const dataFile = path.join(dataRoot, id + '.json');

    fs.mkdirSync(dataRoot, { recursive: true });

    let store = {};
    try {
      store = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    } catch (_) {}

    const api = {
      storage: {
        get(key) {
          return store[key];
        },
        set(key, value) {
          store[key] = value;
          fs.writeFileSync(dataFile, JSON.stringify(store, null, 2) + '\n');
        }
      },
      log(...values) {
        log('PLUGIN ' + id, values.join(' '));
      }
    };

    const sandbox = {
      module: { exports: {} },
      exports: {},
      context: api,
      console: { log: (...values) => api.log(...values) },
      setTimeout,
      clearTimeout
    };

    vm.runInNewContext(source, sandbox, {
      timeout: 1000,
      filename: id + '/index.js'
    });

    const plugin = {
      id,
      metadata,
      api,
      implementation: sandbox.module.exports
    };

    loaded.set(id, plugin);

    if (typeof plugin.implementation.onPluginInit === 'function') {
      plugin.implementation.onPluginInit(api);
    }

    return plugin;
  }

  function init() {
    const enabled = (config.read().enabledPlugins || []).filter(trustedPlugin);

    for (const id of enabled) {
      try {
        load(id);
      } catch (error) {
        log('ERROR', '插件 ' + id + ' 加载失败：' + error.message);
      }
    }
  }

  function hook(name, context) {
    let current = context;

    for (const plugin of loaded.values()) {
      const handler = plugin.implementation[name];
      if (typeof handler !== 'function') continue;

      try {
        const result = handler(current, plugin.api);
        if (result !== undefined && name === 'beforeRequest') {
          current = result;
        }
      } catch (error) {
        log('ERROR', '插件钩子 ' + plugin.id + '/' + name + '：' + error.message);
      }
    }

    return current;
  }

  function list() {
    let directories = [];

    try {
      directories = fs.readdirSync(pluginRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
    } catch (_) {}

    return directories.map(id => {
      try {
        const metadata = JSON.parse(
          fs.readFileSync(path.join(pluginDirectory(id), 'plugin.json'), 'utf8')
        );

        return Object.assign({}, metadata, {
          enabled: loaded.has(id)
        });
      } catch (error) {
        return { id, enabled: loaded.has(id), error: error.message };
      }
    });
  }

  function reload(id) {
    loaded.delete(id);

    if ((config.read().enabledPlugins || []).includes(id)) {
      load(id);
    }

    return list();
  }

  function setEnabled(id, enabled) {
    pluginDirectory(id);
    if (enabled && !trustedPlugin(id)) throw new Error('插件默认禁用。只有加入 NODE_AI_WEB_TRUSTED_PLUGINS 白名单的可信插件才能启用。');

    const current = config.read();
    const enabledIds = new Set(current.enabledPlugins || []);

    if (enabled) {
      enabledIds.add(id);
    } else {
      enabledIds.delete(id);
      loaded.delete(id);
    }

    current.enabledPlugins = Array.from(enabledIds);
    config.write(current);

    if (enabled) {
      load(id);
    }

    return list();
  }

  return { init, hook, list, reload, setEnabled };
};
