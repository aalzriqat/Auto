const fs = require('fs');
const path = require('path');

function walkDir(dir, callback) {
  fs.readdirSync(dir).forEach(f => {
    const dirPath = path.join(dir, f);
    const isDirectory = fs.statSync(dirPath).isDirectory();
    if (isDirectory) {
      walkDir(dirPath, callback);
    } else {
      if (dirPath.endsWith('.tsx') || dirPath.endsWith('.ts')) {
        callback(dirPath);
      }
    }
  });
}

const map = {
  'ml-': 'ms-',
  'mr-': 'me-',
  'pl-': 'ps-',
  'pr-': 'pe-',
  'text-left': 'text-start',
  'text-right': 'text-end',
  'left-': 'start-',
  'right-': 'end-',
};

walkDir(path.join(__dirname, 'app'), processFile);
walkDir(path.join(__dirname, 'components'), processFile);

function processFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  let changed = false;

  // We only want to replace tailwind classes inside classNames or class=" "
  // A simple regex approach replacing word boundaries
  
  Object.keys(map).forEach(key => {
    const val = map[key];
    // Regex for ml-2, mr-4, pl-0, text-left etc.
    const regex = new RegExp(`\\b${key}(?!\\w)`, 'g');
    
    // Exception for specific keys that might match variable names
    // But since they have a dash at the end (like `ml-`) it's usually safe for Tailwind.
    // Wait, `text-left` doesn't have a dash at the end.
    // Let's refine the regex for `text-left` and `text-right`.
    
    if (key.endsWith('-')) {
      const classRegex = new RegExp(`\\b${key}([0-9]+|px|auto|full|screen|\\w+)\\b`, 'g');
      content = content.replace(classRegex, (match, p1) => {
        changed = true;
        return `${val}${p1}`;
      });
    } else {
      const classRegex = new RegExp(`\\b${key}\\b`, 'g');
      content = content.replace(classRegex, (match) => {
        changed = true;
        return val;
      });
    }
  });

  if (changed) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('Updated:', filePath);
  }
}
