import Database, { IDatabaseOptions } from '@nocobase/database';
import Application, { AppManager, InstallOptions, Plugin } from '@nocobase/server';
import lodash from 'lodash';
import * as path from 'path';
import { resolve } from 'path';
import { ApplicationModel } from './models/application';

export type AppDbCreator = (app: Application) => Promise<void>;
export type AppOptionsFactory = (appName: string, mainApp: Application) => any;

const defaultDbCreator = async (app: Application) => {
  const databaseOptions = app.options.database as any;
  const { host, port, username, password, dialect, database } = databaseOptions;

  if (dialect === 'mysql') {
    const mysql = require('mysql2/promise');
    const connection = await mysql.createConnection({ host, port, user: username, password });
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${database}\`;`);
    await connection.close();
  }

  if (dialect === 'postgres') {
    const { Client } = require('pg');

    const client = new Client({
      host,
      port,
      user: username,
      password,
      database: 'postgres',
    });

    await client.connect();

    try {
      await client.query(`CREATE DATABASE "${database}"`);
    } catch (e) {}

    await client.end();
  }
};

const defaultAppOptionsFactory = (appName: string, mainApp: Application) => {
  const rawDatabaseOptions = PluginMultiAppManager.getDatabaseConfig(mainApp);

  if (rawDatabaseOptions.dialect === 'sqlite') {
    const mainAppStorage = rawDatabaseOptions.storage;
    if (mainAppStorage !== ':memory:') {
      const mainStorageDir = path.dirname(mainAppStorage);
      rawDatabaseOptions.storage = path.join(mainStorageDir, `${appName}.sqlite`);
    }
  } else {
    rawDatabaseOptions.database = appName;
  }

  return {
    database: {
      ...rawDatabaseOptions,
      tablePrefix: '',
    },
    plugins: ['nocobase'],
    resourcer: {
      prefix: '/api',
    },
  };
};

export class PluginMultiAppManager extends Plugin {
  appDbCreator: AppDbCreator = defaultDbCreator;
  appOptionsFactory: AppOptionsFactory = defaultAppOptionsFactory;

  setAppOptionsFactory(factory: AppOptionsFactory) {
    this.appOptionsFactory = factory;
  }

  setAppDbCreator(appDbCreator: AppDbCreator) {
    this.appDbCreator = appDbCreator;
  }

  static getDatabaseConfig(app: Application): IDatabaseOptions {
    const oldConfig =
      app.options.database instanceof Database
        ? (app.options.database as Database).options
        : (app.options.database as IDatabaseOptions);

    return lodash.cloneDeep(lodash.omit(oldConfig, ['migrator']));
  }

  async install(options?: InstallOptions) {
    // const repo = this.db.getRepository<any>('collections');
    // if (repo) {
    //   await repo.db2cm('applications');
    // }
  }

  beforeLoad() {
    this.db.registerModels({
      ApplicationModel,
    });
  }

  async load() {
    this.app.appManager.setAppSelector(async (req) => {
      if (req.headers['x-app']) {
        return req.headers['x-app'];
      }
      if (req.headers['x-hostname']) {
        const appInstance = await this.db.getRepository('applications').findOne({
          filter: {
            cname: req.headers['x-hostname'],
          },
        });
        if (appInstance) {
          return appInstance.name;
        }
      }
      return null;
    });

    await this.db.import({
      directory: resolve(__dirname, 'collections'),
    });

    this.db.on('applications.afterCreateWithAssociations', async (model: ApplicationModel, options) => {
      const { transaction } = options;

      await model.registerToMainApp(this.app, {
        transaction,
        dbCreator: this.appDbCreator,
        appOptionsFactory: this.appOptionsFactory,
      });
    });

    this.db.on('applications.afterDestroy', async (model: ApplicationModel) => {
      await this.app.appManager.removeApplication(model.get('name') as string);
    });

    this.app.appManager.on(
      'beforeGetApplication',
      async ({ appManager, name }: { appManager: AppManager; name: string }) => {
        if (!appManager.applications.has(name)) {
          const existsApplication = (await this.app.db.getRepository('applications').findOne({
            filter: {
              name,
            },
          })) as ApplicationModel | null;

          if (existsApplication) {
            await existsApplication.registerToMainApp(this.app, {
              dbCreator: this.appDbCreator,
              appOptionsFactory: this.appOptionsFactory,
            });
          }
        }
      },
    );

    this.app.resourcer.registerActionHandlers({
      'applications:listPinned': async (ctx, next) => {
        const items = await this.db.getRepository('applications').find({
          filter: {
            pinned: true,
          },
        });
        ctx.body = items;
      },
    });

    this.app.acl.allow('applications', 'listPinned', 'loggedIn');

    this.app.acl.registerSnippet({
      name: `pm.${this.name}.applications`,
      actions: ['applications:*'],
    });
  }
}
