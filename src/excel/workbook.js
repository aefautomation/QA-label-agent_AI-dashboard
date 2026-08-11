import xlsx from 'xlsx';

export function readWorkbook(filePath) {
  return xlsx.readFile(filePath, {
    cellDates: false,
    cellNF: false,
    cellText: true,
    raw: false
  });
}

export function sheetRows(workbook, sheetName) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    throw new Error(`Werkblad "${sheetName}" is niet gevonden. Beschikbare tabs: ${workbook.SheetNames.join(', ')}`);
  }

  return xlsx.utils.sheet_to_json(sheet, {
    header: 1,
    raw: false,
    blankrows: false,
    defval: ''
  });
}
