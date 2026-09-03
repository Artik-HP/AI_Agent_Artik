import ExcelJS from 'exceljs';
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

/**
 * Генерация отчета по закупкам в формат XLSX
 * @param {Array<any>} productsData - массив товаров с продажами и остатками
 * @param {string} outputPath - путь, куда сохранить готовый файл
 * @param {{ periodDays?: number }} [options] - длина периода отчёта в днях
 */
export async function generateProcurementReport(productsData, outputPath, options = {}) {
    const { delivery_days, safety_stock_days, default_period_days } = loadSupplySettings();
    const periodDays = Number(options.periodDays) > 0
      ? Number(options.periodDays)
      : default_period_days;

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Закупки');

    // 1. Создаем шапку таблицы (Аналог вашей структуры)
    worksheet.mergeCells('A1:B1');
    worksheet.getCell('A1').value = 'Номенклатура';
    worksheet.getCell('C1').value = 'Начало';
    worksheet.getCell('D1').value = 'Приход';
    worksheet.mergeCells('E1:G1');
    worksheet.getCell('E1').value = 'Расход (14 дней)';
    worksheet.getCell('H1').value = 'Текущий остаток';
    worksheet.getCell('I1').value = 'Скорость продаж в день';
    worksheet.getCell('J1').value = 'Страховой запас';
    worksheet.getCell('K1').value = 'РЕКОМЕНДУЕМАЯ ЗАКУПКА';

    // Вторая строчка заголовков
    worksheet.getRow(2).values = [
        'Артикул', 'Наименование', 'Кількість', 'Кількість', 
        'Розничные', 'Покупателю', 'Списание (Всего)', 
        'Конец', 'Шт/День', 'Шт', 'Заказ (Шт)'
    ];

    // Стилизуем шапку (делаем жирным)
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(2).font = { bold: true };

    // 2. Наполняем таблицу данными и формулами логистики
    productsData.forEach(prod => {
        // Суммарный расход за период отчёта (все типы списаний)
        const totalSold = prod.soldRetail + prod.soldCustomer + prod.writeOff;

        // Математика логистики (как в прошлой формуле)
        const dailyRate = totalSold / periodDays;
        const safetyStock = dailyRate * safety_stock_days;
        const totalRequired = (dailyRate * delivery_days) + safetyStock;
        
        // Сколько нужно заказать (Потребность минус остаток на конец)
        let orderVolume = totalRequired - prod.endStock;
        if (orderVolume < 0) orderVolume = 0;

        // Записываем строчку в Excel
        worksheet.addRow([
            prod.sku,                           // A: Артикул
            prod.name,                          // B: Наименование
            prod.startStock,                    // C: Начало
            prod.income,                        // D: Приход
            prod.soldRetail,                    // E: Отчет о рознице
            prod.soldCustomer,                  // F: Продажа покупателю
            totalSold,                          // G: Расход всего
            prod.endStock,                      // H: Остаток Конец
            parseFloat(dailyRate.toFixed(1)),   // I: Скорость продаж
            Math.round(safetyStock),            // J: Страховой запас
            Math.round(orderVolume)             // K: РЕКОМЕНДУЕМАЯ ЗАКУПКА
        ]);
    });

    // Автоматическая ширина колонок для красоты
    worksheet.columns.forEach(column => {
        column.width = 20;
    });

    // Сохраняем файл на диск
    await workbook.xlsx.writeFile(outputPath);
}
