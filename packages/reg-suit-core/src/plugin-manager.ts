import * as resolve from "resolve";
import {
  Plugin,
  PluginPreparer,
  CreateQuestionsOptions,
  RegSuitConfiguration,
  KeyGeneratorPlugin,
  KeyGeneratorPluginHolder,
  PublisherPlugin,
  PublisherPluginHolder,
  NotifierPlugin,
  NotifierPluginHolder,
} from "reg-suit-interface";
import { RegLogger } from "reg-suit-util";

export interface PluginMetadata {
  moduleId: string;
  [key: string]: any;
}

function isPublisher(pluginHolder: PluginMetadata): pluginHolder is (PublisherPluginHolder<any, any> & PluginMetadata) {
  return !!pluginHolder["publisher"];
}

function isKeyGenerator(pluginHolder: PluginMetadata): pluginHolder is (KeyGeneratorPluginHolder<any, any> & PluginMetadata) {
  return !!pluginHolder["keyGenerator"];
}

function isNotifier(pluginHolder: PluginMetadata): pluginHolder is (NotifierPluginHolder<any, any> & PluginMetadata) {
  return !!pluginHolder["notifier"];
}

export class PluginManager {

  _pluginHolders: PluginMetadata[] = [];
  rawConfig: RegSuitConfiguration;
  replacedConfig?: RegSuitConfiguration;

  constructor(private _logger: RegLogger, private _noEmit: boolean) {
  }

  loadPlugins() {
    if (!this.rawConfig.plugins) return;
    const pluginNames = Object.keys(this.rawConfig.plugins);
    pluginNames.forEach(pluginName => {
      this._loadPlugin(pluginName);
    });
  }

  createQuestions(opt: CreateQuestionsOptions) {
    const config = this.rawConfig;
    const noConfigurablePlugins: string[] = [];
    const preparerHolders : { name: string; preparer: PluginPreparer<any, any> }[] = [];
    opt.pluginNames.forEach(name => this._loadPlugin(name));
    this._pluginHolders.forEach(h => {
      if (h["preparer"]) {
        preparerHolders.push({ name: h.moduleId, preparer: h["preparer"] });
      } else {
        noConfigurablePlugins.push(h.moduleId);
      }
    });
    return [
      ...noConfigurablePlugins.map(pluginName => {
        return {
          name: pluginName,
          questions: [] as any[],
          prepare: (inquireResult: any) => Promise.resolve<any>(true),
          configured: null,
        };
      }),
      ...preparerHolders.map(holder => {
        const questions = holder.preparer.inquire();
        const boundPrepare = (inquireResult: any) => holder.preparer.prepare({
          coreConfig: config.core,
          logger: this._logger.fork(holder.name),
          options: inquireResult,
          noEmit: this._noEmit,
        });
        const configured = (config.plugins && typeof config.plugins[holder.name] === "object") ? config.plugins[holder.name] : null;
        return {
          name: holder.name,
          // FIXME
          // TS4053 Return type of public method from exported class has or is using name 'inquirer.Question' from external module "reg-suit-core/node_modules/@types/inquirer/index" but cannot be named.
          questions: questions as any[],
          prepare: boundPrepare,
          configured,
        };
      }),
    ];
  }

  initKeyGenerator() {
    const metadata = this._pluginHolders.filter(holder => isKeyGenerator(holder));
    if (metadata.length === 0) {
      this._logger.verbose("No key generator plugin.");
      return;
    } else if (metadata.length > 1) {
      const pluginNames = metadata.map(p => p.moduleId).join(", ");
      this._logger.warn(`2 or more key generator plugins are found. Select one of ${pluginNames}.`);
      return;
    }
    const ph = metadata[0];
    if (isKeyGenerator(ph)) {
      return this._initPlugin(ph.keyGenerator, ph);
    }
  }

  initPublisher() {
    const metadata = this._pluginHolders.filter(holder => isPublisher(holder));
    if (metadata.length === 0) {
      this._logger.verbose("No publisher plugin.");
      return;
    }else if (metadata.length > 1) {
      const pluginNames = metadata.map(p => p.moduleId).join(", ");
      this._logger.warn(`2 or more publisher plugins are found. Select one of ${pluginNames}.`);
      return;
    }
    const ph = metadata[0];
    if (isPublisher(ph)) {
      return this._initPlugin(ph.publisher, ph);
    }
  }

  initNotifiers() {
    const notifiers: NotifierPlugin<any>[] = [];
    const metadata = this._pluginHolders.filter(holder => isNotifier(holder));
    if (metadata.length === 0) {
      this._logger.verbose("No notifier plugin.");
    } else {
      metadata.forEach(ph => {
        if (isNotifier(ph)) {
          const np = this._initPlugin(ph.notifier, ph);
          np && notifiers.push(np);
        }
      });
    }
    return notifiers;
  }

  private _loadPlugin(name: string) {
    let pluginFileName = null;
    try {
      pluginFileName = resolve.sync(name, { basedir: process.cwd() });
    } catch (e) {
      this._logger.error(`Failed to load plugin '${name}'`);
      throw e;
    }
    if (pluginFileName) {
      const factory = require(pluginFileName);
      const pluginHolder = factory();
      this._pluginHolders.push({ ...pluginHolder, moduleId: name });
    }
  }

  private _initPlugin<S extends { disabled?: boolean }, P extends Plugin<S>>(targetPlugin: P, metadata: PluginMetadata): P | undefined {
    if (!this.replacedConfig) throw new Error("Invalid state");
    const replacedConf = this.replacedConfig;
    let pluginSpecifiedOption: S;
    if (replacedConf.plugins && replacedConf.plugins[metadata.moduleId]) {
      pluginSpecifiedOption = replacedConf.plugins[metadata.moduleId];
    } else {
      pluginSpecifiedOption = { disabled: true } as S;
    }
    if (pluginSpecifiedOption.disabled === true) {
      this._logger.verbose(`${metadata.moduleId} is disabled.`);
      return;
    }
    targetPlugin.init({
      coreConfig: this.replacedConfig.core,
      logger: this._logger.fork(metadata.moduleId),
      options: pluginSpecifiedOption,
      noEmit: this._noEmit,
    });
    this._logger.verbose(`${metadata.moduleId} is inialized with: `, pluginSpecifiedOption);
    return targetPlugin;
  }

}