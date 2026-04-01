const fs = require('fs');
const path = require('path');

function hasPathSeparator(value) {
  return /[\\/]/.test(value);
}

function getExistingPath(candidate) {
  if (!candidate) return '';
  try {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  } catch {
    return '';
  }
  return '';
}

function resolveBinary(envVarName, options = {}) {
  const {
    command = '',
    windowsCommand = `${command}.exe`,
    windowsLocations = []
  } = options;

  const configured = String(process.env[envVarName] || '').trim();
  if (configured) {
    const existingConfiguredPath = getExistingPath(configured);
    if (existingConfiguredPath) {
      return existingConfiguredPath;
    }

    if (!hasPathSeparator(configured)) {
      return configured;
    }
  }

  if (process.platform === 'win32') {
    for (const location of windowsLocations) {
      const existingPath = getExistingPath(location);
      if (existingPath) {
        return existingPath;
      }
    }
    return windowsCommand;
  }

  return command;
}

function resolvePandocBinary() {
  return resolveBinary('PANDOC_BIN', {
    command: 'pandoc',
    windowsCommand: 'pandoc.exe',
    windowsLocations: [
      process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, 'Pandoc', 'pandoc.exe')
        : '',
      process.env.ProgramFiles
        ? path.join(process.env.ProgramFiles, 'Pandoc', 'pandoc.exe')
        : ''
    ]
  });
}

function resolvePdflatexBinary() {
  return resolveBinary('PDFLATEX_BIN', {
    command: 'pdflatex',
    windowsCommand: 'pdflatex.exe',
    windowsLocations: [
      process.env.LOCALAPPDATA
        ? path.join(
            process.env.LOCALAPPDATA,
            'Programs',
            'MiKTeX',
            'miktex',
            'bin',
            'x64',
            'pdflatex.exe'
          )
        : ''
    ]
  });
}

module.exports = {
  resolveBinary,
  resolvePandocBinary,
  resolvePdflatexBinary
};
