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

// Правила переноса товара между магазинами. Отдельно от снабжения: там речь
// про закупку у поставщика, здесь — про то, что уже лежит в сети.
const DEFAULT_TRANSFER_SETTINGS = {
  cover_days: 36,
  max_stock_days: 30,
  min_batch: 2,
  exclude_sku_patterns: ["^p\\d+$"]
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

/**
 * Лениво читает transfer_settings из config.yaml.
 * @returns {{ cover_days: number, max_stock_days: number, min_batch: number, exclude_sku_patterns: string[] }}
 */
export function loadTransferSettings() {
  try {
    const configPath = path.resolve(process.cwd(), 'config.yaml');
    const parsed = YAML.parse(fs.readFileSync(configPath, 'utf8'));

    return {
      ...DEFAULT_TRANSFER_SETTINGS,
      ...(parsed && parsed.transfer_settings ? parsed.transfer_settings : {})
    };
  } catch {
    return { ...DEFAULT_TRANSFER_SETTINGS };
  }
}
