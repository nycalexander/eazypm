#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { spawnSync, spawn } from 'child_process';
import chalk from 'chalk';
import ora from 'ora';
import Enquirer from 'enquirer';
import { consola } from 'consola';

const { Select, Confirm } = Enquirer;
const cwd = process.cwd();

// Gracefully handle Ctrl+C / unhandled rejections
process.on('SIGINT', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

/** Detect the package manager by lock files */
const detectPM = () => {
  const locks = [
    ['pnpm', 'pnpm-lock.yaml'],
    ['yarn', 'yarn.lock'],
    ['npm', 'package-lock.json'],
    ['bun', 'bun.lockb'],
  ];
  const detected = locks.find(([_, file]) => fs.existsSync(path.join(cwd, file)));
  return detected ? detected[0] : 'npm';
};

/** Check if a package manager is installed */
const isPMInstalled = (pm) => spawnSync(pm, ['--version'], { stdio: 'ignore', shell: true }).status === 0;

/** Read dependencies from package.json and package-lock.json */
const readDependencies = () => {
  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) return [];

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const deps = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }).map(([name, version]) => ({ name, version }));

  const lockPath = path.join(cwd, 'package-lock.json');
  if (fs.existsSync(lockPath)) {
    try {
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      Object.entries(lock.dependencies || {}).forEach(([name, info]) => {
        if (!info.version) return;
        const idx = deps.findIndex(d => d.name === name);
        if (idx > -1) deps[idx].version = info.version;
        else deps.push({ name, version: info.version });
      });
    } catch {}
  }

  return deps;
};

/** Backup project files */
const backupProject = () => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(cwd, `backup-${timestamp}`);
  fs.mkdirSync(backupDir);

  ['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb'].forEach(f => {
    const fp = path.join(cwd, f);
    if (fs.existsSync(fp)) fs.copyFileSync(fp, path.join(backupDir, f));
  });

  const nm = path.join(cwd, 'node_modules');
  if (fs.existsSync(nm)) fs.renameSync(nm, path.join(backupDir, 'node_modules'));

  return backupDir;
};

/** Run a command asynchronously, hides stdout/stderr for spinner-friendliness */
const runCommand = (command, args, cwd) =>
  new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd, stdio: 'ignore', shell: true });
    proc.on('error', reject);
    proc.on('close', code => (code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`))));
  });

/** Ensure Aikido is installed */
const ensureAikido = async (pm, spinner) => {
  try {
    await runCommand(`aikido-${pm}`, ['--version'], cwd);
  } catch {
    spinner.text = `Installing aikido-${pm} locally 🛠`;
    await runCommand('npm', ['install', '--no-save', `aikido-${pm}`], cwd);
  }
};

/** Generate safe-chain command */
const getSafeChainCmd = (pm, deps) => {
  const action = pm === 'npm' || pm === 'bun' ? 'install' : 'add';
  return `aikido-${pm} ${action} ${deps.map(d => `${d.name}@${d.version}`).join(' ')}`;
};

/** Remove all packages via native PM before reinstall */
const removePackages = async (pm, spinner) => {
  spinner.text = 'Removing existing packages 🧹';
  if (pm === 'npm' || pm === 'bun') {
    await runCommand(pm, ['remove', ...fs.existsSync(path.join(cwd, 'package.json')) 
      ? Object.keys(JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')).dependencies || {}) 
      : []], cwd);
  } else if (pm === 'yarn' || pm === 'pnpm') {
    await runCommand(pm, ['remove', ...fs.existsSync(path.join(cwd, 'package.json')) 
      ? Object.keys(JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')).dependencies || {}) 
      : []], cwd);
  }
};

(async () => {
  // Sword intro
  console.log('\n');
  console.log(chalk.gray('    /'));
  console.log(chalk.gray('O===[') + chalk.white('====================-'));
  console.log(chalk.gray('    \\'));
  console.log('\n');
  console.log(chalk.whiteBright.bold('ᶻ 𝗓 𐰁 eazypm - easy & safe dependency reinstaller\n'));

  // PM selection
  const detectedPM = detectPM();
  const pmChoices = ['npm', 'pnpm', 'yarn', 'bun'].map(pm => ({
    name: pm === detectedPM ? `${pm} (detected)` : pm,
    value: pm,
    disabled: isPMInstalled(pm) ? false : '(not installed)'
  }));

  const pm = await new Select({
    name: 'pm',
    message: 'What package manager should be used to reinstall?',
    choices: pmChoices,
    initial: pmChoices.findIndex(p => p.value === detectedPM && !p.disabled)
  }).run();

  const selectedPM = pm.replace(' (detected)', '');
  const deps = readDependencies();

  if (!deps.length) {
    consola.error('No dependencies found, you might be in the wrong directory or missing a dependencies file ❌');
    process.exit(1);
  }

  const spinner = ora({ text: 'Preparing eazypm ⚡', spinner: 'dots' }).start();
  await ensureAikido(selectedPM, spinner);

  const cmd = getSafeChainCmd(selectedPM, deps);
  fs.writeFileSync(path.join(cwd, 'install-command.txt'), cmd);
  spinner.stop();

  console.log('Command saved to install-command.txt ✅\n');
  console.log(chalk.greenBright(`Install Command:\n${cmd}\n`));

  const doRun = await new Confirm({
    name: 'run',
    message: 'Do you want to backup and run the safe-chained install automatically?',
    initial: true
  }).run();

  if (doRun) {
    const backupDir = backupProject();
    console.log(`Backup created at: ${backupDir} 📦\n`); // newline before spinner

    const runSpinner = ora({ text: 'Reinstalling dependencies using safe-chain ⚡', spinner: 'dots' }).start();
    try {
      // Remove existing packages before installing
      await removePackages(selectedPM, runSpinner);

      // Native PM install
      runSpinner.text = `Reinstalling dependencies using safe-chain ⚡`;
      const pmArgs = selectedPM === 'bun' ? ['install'] : ['install', '--silent'];
      await runCommand(selectedPM, pmArgs, cwd);

      // Run aikido safe-chain
      const [aikidoCmd, ...aikidoArgs] = cmd.split(' ');
      await runCommand(aikidoCmd, aikidoArgs, cwd);

      runSpinner.succeed('eazypm safe-chain install completed 🎉');
    } catch (err) {
      runSpinner.fail('Something went wrong during installation ❌');
      consola.error(err.message);
    }
  } else {
    console.log('\n');
    console.log('Skipped automatic reinstallation. You can run the command from install-command.txt manually');
  }
})();
