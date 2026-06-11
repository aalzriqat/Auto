const fs = require('fs');
try {
  const data = JSON.parse(fs.readFileSync('e:/Auto/Auto/guide_all.json', 'utf8'));
  const guide = data['Guide'];
  for (const row of guide) {
    const vals = Object.values(row).filter(v => v !== null && v !== 'NaN');
    if (vals.length > 0) {
      console.log(vals);
    }
  }
} catch (e) {
  console.log(e);
}
