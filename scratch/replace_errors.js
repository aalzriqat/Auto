const fs = require('fs');
const path = require('path');

function walk(dir) {
    let results = [];
    const list = fs.readdirSync(dir);
    list.forEach(function(file) {
        file = dir + '/' + file;
        const stat = fs.statSync(file);
        if (stat && stat.isDirectory()) { 
            results = results.concat(walk(file));
        } else if (file.endsWith('.ts')) { 
            results.push(file);
        }
    });
    return results;
}

const files = walk('e:/Auto/Auto/convex');
let changed = 0;

for (const file of files) {
  let content = fs.readFileSync(file, 'utf8');
  let newContent = content.replace(/throw new Error\(/g, 'throw new ConvexError(');
  if (content !== newContent) {
    if (!newContent.match(/import.*ConvexError/)) {
        if (newContent.match(/import \{ v \}/)) {
            newContent = newContent.replace(/import \{ v \}/, 'import { v, ConvexError }');
        } else {
            newContent = 'import { ConvexError } from "convex/values";\n' + newContent;
        }
    }
    fs.writeFileSync(file, newContent, 'utf8');
    changed++;
    console.log('Fixed ' + file);
  }
}
console.log('Done. Changed ' + changed + ' files.');
