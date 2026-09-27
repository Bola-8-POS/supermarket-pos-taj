export interface ExtractedProduct {
  name: string;
  price: number;
}

export function parseProductsCsv(csvText: string): ExtractedProduct[] {
  const lines = csvText.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];

  const headerLine = lines[0];
  if (!headerLine) return [];

  const headers = headerLine.split(',').map((h) => h.trim().toLowerCase());

  const nameIdx = headers.findIndex((h) => h === 'name' || h === 'nombre');
  const priceIdx = headers.findIndex((h) => h === 'price' || h === 'precio');

  if (nameIdx === -1 || priceIdx === -1) return [];

  const products: ExtractedProduct[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    const cols = line.split(',');
    const rawName = cols[nameIdx]?.trim() ?? '';
    const rawPrice = cols[priceIdx]?.trim() ?? '';

    if (!rawName) continue;

    const price = parseFloat(rawPrice);
    if (!isFinite(price)) continue;

    products.push({ name: rawName, price });
  }

  return products;
}
