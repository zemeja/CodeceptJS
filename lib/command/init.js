const colors = require('chalk');
const fs = require('fs');
const inquirer = require('inquirer');
const mkdirp = require('mkdirp');
const path = require('path');
const { inspect } = require('util');
const spawn = require('cross-spawn');

const { print, success, error } = require('../output');
const { fileExists, beautify, installedLocally } = require('../utils');
const { getTestRoot } = require('./utils');
const generateDefinitions = require('./definitions');
const { test: generateTest } = require('./generate');
const isLocal = require('../utils').installedLocally();

const defaultConfig = {
  tests: './*_test.js',
  output: '',
  helpers: {},
  include: {},
  bootstrap: null,
  mocha: {},
};

const helpers = ['Playwright', 'WebDriver', 'Puppeteer', 'REST', 'GraphQL', 'Appium', 'TestCafe', 'Nightmare'];
const translations = Object.keys(require('../../translations'));

const noTranslation = 'English (no localization)';
translations.unshift(noTranslation);

let packages;

const configHeader = `const { setHeadlessWhen, setCommonPlugins } = require('@codeceptjs/configure');

// turn on headless mode when running with HEADLESS=true environment variable
// export HEADLESS=true && npx codeceptjs run
setHeadlessWhen(process.env.HEADLESS);

// enable all common plugins https://github.com/codeceptjs/configure#setcommonplugins
setCommonPlugins();

`;

const defaultActor = `// in this file you can append custom step methods to 'I' object

module.exports = function() {
  return actor({

    // Define custom steps here, use 'this' to access default methods of I.
    // It is recommended to place a general 'login' function here.

  });
}
`;

module.exports = function (initPath) {
  const testsPath = getTestRoot(initPath);

  print();
  print(`  Welcome to ${colors.magenta.bold('CodeceptJS')} initialization tool`);
  print('  It will prepare and configure a test environment for you');
  print();

  if (!path) {
    print('No test root specified.');
    print(`Test root is assumed to be ${colors.yellow.bold(testsPath)}`);
    print('----------------------------------');
  } else {
    print(`Installing to ${colors.bold(testsPath)}`);
  }

  if (!fileExists(testsPath)) {
    print(`Directory ${testsPath} does not exist, creating...`);
    mkdirp.sync(testsPath);
  }

  const configFile = path.join(testsPath, 'codecept.conf.js');
  if (fileExists(configFile)) {
    error(`Config is already created at ${configFile}`);
    return;
  }

  inquirer.prompt([
    {
      name: 'tests',
      type: 'input',
      default: './*_test.js',
      message: 'Where are your tests located?',
    },
    {
      name: 'helper',
      type: 'list',
      choices: helpers,
      message: 'What helpers do you want to use?',
    },
    {
      name: 'output',
      default: './output',
      message: 'Where should logs, screenshots, and reports to be stored?',
    },
    {
      name: 'translation',
      type: 'list',
      message: 'Do you want localization for tests? (See https://codecept.io/translation/)',
      choices: translations,
    },
  ]).then((result) => {
    const config = defaultConfig;
    config.name = testsPath.split(path.sep).pop();
    config.output = result.output;

    config.tests = result.tests;
    // create a directory tests if it is included in tests path
    const matchResults = config.tests.match(/[^*.]+/);
    if (matchResults) {
      mkdirp.sync(path.join(testsPath, matchResults[0]));
    }

    // append file mask to the end of tests
    if (!config.tests.match(/\*(.*?)$/)) {
      config.tests = `${config.tests.replace(/\/+$/, '')}/*_test.js`;
      print(`Adding default test mask: ${config.tests}`);
    }

    if (result.translation !== noTranslation) config.translation = result.translation;

    const helperName = result.helper;
    config.helpers[helperName] = {};

    let helperConfigs = [];

    try {
      const Helper = require(`../helper/${helperName}`);
      if (Helper._checkRequirements) {
        packages = Helper._checkRequirements();
      }

      if (!Helper._config()) return;
      helperConfigs = helperConfigs.concat(Helper._config().map((config) => {
        config.message = `[${helperName}] ${config.message}`;
        config.name = `${helperName}_${config.name}`;
        config.type = config.type || 'input';
        return config;
      }));
    } catch (err) {
      error(err);
    }

    const finish = async () => {
      // create steps file by default
      const stepFile = './steps_file.js';
      fs.writeFileSync(path.join(testsPath, stepFile), defaultActor);
      config.include.I = stepFile;
      print(`Steps file created at ${stepFile}`);

      let configSource = beautify(`exports.config = ${inspect(config, false, 4, false)}`);

      if (require.resolve('@codeceptjs/configure') && isLocal && !initPath) {
        // prepend @codeceptjs/configure only when this module can be required in config
        configSource = configHeader + configSource;
      }

      fs.writeFileSync(configFile, configSource, 'utf-8');
      print(`Config created at ${configFile}`);

      if (config.output) {
        if (!fileExists(config.output)) {
          mkdirp.sync(path.join(testsPath, config.output));
          print(`Directory for temporary output files created at '${config.output}'`);
        } else {
          print(`Directory for temporary output files is already created at '${config.output}'`);
        }
      }

      const jsconfig = {
        compilerOptions: {
          allowJs: true,
        },
      };
      const jsconfigJson = beautify(JSON.stringify(jsconfig));
      const jsconfigFile = path.join(testsPath, 'jsconfig.json');
      if (fileExists(jsconfigFile)) {
        print(`jsconfig.json already exists at ${jsconfigFile}`);
      } else {
        fs.writeFileSync(jsconfigFile, jsconfigJson);
        print(`Intellisense enabled in ${jsconfigFile}`);
      }

      const generateDefinitionsManually = colors.bold(`To get auto-completion support, please generate type definitions: ${colors.green('npx codeceptjs def')}`);

      if (packages) {
        try {
          install(packages);

          if (testsPath) {
            print(generateDefinitionsManually);
          } else {
            const { code } = spawn.sync('npx', ['codeceptjs', 'def']);
            if (code !== 0) {
              print(generateDefinitionsManually);
            }
          }
        } catch (err) {
          print(colors.bold.red(err.toString()));
          print();
          print(colors.bold.red('Please install next packages manually:'));
          print(`npm i ${packages.join(' ')} --save-dev`);
          print();
          print('Things to do after missing packages installed:');
          print('☑', generateDefinitionsManually);
          print('☑ Create first test:', colors.green('npx codeceptjs gt'));
          print(colors.bold.magenta('Find more information at https://codecept.io'));
          return;
        }
      } else {
        try {
          generateDefinitions(testsPath, {});
        } catch (err) {
          print(colors.bold.red('Couldn\'t generate type definitions'));
          print(colors.red(err.toString()));
          print('Skipping type definitions...');
        }
      }

      print('');
      success(' Almost ready... Next step:');

      const generatedTest = generateTest(testsPath);
      if (!generatedTest) return;
      generatedTest.then(() => {
        print('\n--');
        print(colors.bold.green('CodeceptJS Installed! Enjoy supercharged testing! 🤩'));
        print(colors.bold.magenta('Find more information at https://codecept.io'));
        print();
      });
    };

    print('Configure helpers...');
    inquirer.prompt(helperConfigs).then((helperResult) => {
      Object.keys(helperResult).forEach((key) => {
        const parts = key.split('_');
        const helperName = parts[0];
        const configName = parts[1];
        if (!configName) return;
        config.helpers[helperName][configName] = helperResult[key];
      });

      print('');
      finish();
    });
  });
};

function install(dependencies, verbose) {
  let command;
  let args;

  if (!fs.existsSync(path.join(process.cwd(), 'package.json'))) {
    dependencies.push('codeceptjs');
    throw new Error("Error: 'package.json' file not found. Generate it with 'npm init -y' command.");
  }

  if (!installedLocally()) {
    console.log('CodeceptJS should be installed locally');
    dependencies.push('codeceptjs');
  }

  console.log('Installing packages: ', colors.green(dependencies.join(', ')));

  if (fileExists('yarn.lock')) {
    command = 'yarnpkg';
    args = ['add', '-D', '--exact'];
    [].push.apply(args, dependencies);

    args.push('--cwd');
    args.push(process.cwd());
  } else {
    command = 'npm';
    args = [
      'install',
      '--save-dev',
      '--loglevel',
      'error',
    ].concat(dependencies);
  }

  const { status } = spawn.sync(command, args, { stdio: 'inherit' });
  if (status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed`);
  }
  return true;
}
