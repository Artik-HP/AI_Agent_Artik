import fs from "node:fs";
import xlsx from "xlsx";
const dir = "data/telegram/999999";
fs.mkdirSync(dir, { recursive: true });
function make(file, sheets) {
  const wb = xlsx.utils.book_new();
  for (const s of sheets) xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([["A1", "Товар", 1]]), s);
  xlsx.writeFile(wb, `${dir}/${file}`);
}
make("1700000001-staraya.xlsx", ["Т1", "Т2"]);
make("1700000002-svezhaya.xlsx", ["Т9", "Т10", "Т11"]);
const now = Date.now();
fs.utimesSync(`${dir}/1700000001-staraya.xlsx`, new Date(now - 86400000), new Date(now - 86400000));
fs.utimesSync(`${dir}/1700000002-svezhaya.xlsx`, new Date(now), new Date(now));
console.log("ok");
