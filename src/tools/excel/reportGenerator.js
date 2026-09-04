import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

// Значения по умолчанию — используются, если config.yaml отсутствует или повреждён.
const DEFAULT_SUPPLY_SETTINGS = {
  delivery_days: 14,
  safety_stock_days: 7,
  default_period_days: 14,
  min_sell_through: 0.4,
  sku_prefixes: ["PJ", "SX", "SO", "FM", "AD", "MD", "AL"]
};

/**
 * Лениво читает supply_settings из config.yaml.
 * Ошибка чтения/парсинга не роняет импорт модуля — возвращаются дефолты.
 * @returns {{ delivery_days: number, safety_stock_days: number, default_period_days: number }}
 */
export function loadSupplySettings() {
  try {
    const configPath = path.resolve(process.cwd(), 'config.yaml');
    const parsed = YAML.parse(fs.readFileSync(configPath, 'utf8'));

    return {
      ...DEFAULT_SUPPLY_SETTINGS,
      ...(parsed && parsed.supply_settings ? parsed.supply_settings : {})
    };
  } catch {
    return { ...DEFAULT_SUPPLY_SETTINGS };
  }
}
