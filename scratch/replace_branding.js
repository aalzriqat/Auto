const fs = require('fs');
const path = require('path');

function walk(dir) {
    let results = [];
    const list = fs.readdirSync(dir);
    list.forEach(function(file) {
        file = dir + '/' + file;
        const stat = fs.statSync(file);
        if (stat && stat.isDirectory() && !file.includes('node_modules') && !file.includes('.next') && !file.includes('.git')) { 
            results = results.concat(walk(file));
        } else if (file.endsWith('.ts') || file.endsWith('.tsx')) { 
            results.push(file);
        }
    });
    return results;
}

const files = walk('e:/Auto/Auto');
let changed = 0;

for (const file of files) {
  let content = fs.readFileSync(file, 'utf8');
  let newContent = content.replace(/Bloom Cars/g, 'AutoFlow');
  if (content !== newContent) {
    fs.writeFileSync(file, newContent, 'utf8');
    changed++;
    console.log('Fixed ' + file);
  }
}
console.log('Done. Changed ' + changed + ' files.');
