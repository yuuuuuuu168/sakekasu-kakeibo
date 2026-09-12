import { describe, expect, it } from 'vitest';
import { detectColumns, isMappingComplete } from '../statement/columns';
import { parseCsv } from '../statement/csv';

/** 楽天カードの形。ヘッダあり、金額の列が 3 つある */
const RAKUTEN = [
  '利用日,利用店名・商品名,利用者,支払方法,利用金額,支払手数料,支払総額',
  '2026/09/01,セブン－イレブン品川,本人,1回,1200,0,1200',
  '2026/09/03,AMAZON.CO.JP*M12AB3CD4,本人,1回,3480,0,3480',
].join('\n');

/** PayPay の形。出金と入金が別の列 */
const PAYPAY = [
  '取引日,出金金額(円),入金金額(円),通貨,取引内容,取引先,取引方法',
  '2026/09/03,850,,JPY,支払い,ローソン品川駅前店,PayPay残高',
  '2026/09/05,,1200,JPY,返金,ローソン品川駅前店,PayPay残高',
].join('\n');

/** 三井住友カードの古い形。ヘッダが無い */
const HEADERLESS = [
  '2026/09/01,セブン-イレブン,1200,1回,,1200',
  '2026/09/04,マツモトキヨシ 五反田,2380,1回,,2380',
  '2026/09/07,スターバックス 品川,620,1回,,620',
].join('\n');

describe('detectColumns', () => {
  it('楽天カードの列を当てる', () => {
    const mapping = detectColumns(parseCsv(RAKUTEN));
    expect(mapping.headerRowIndex).toBe(0);
    expect(mapping.date).toBe(0);
    expect(mapping.merchant).toBe(1);
    // 支払総額ではなく利用金額を選ぶ
    expect(mapping.amount).toBe(4);
    expect(mapping.sign).toBe('positive-expense');
    expect(isMappingComplete(mapping)).toBe(true);
  });

  it('PayPay の出金列を金額、入金列を返金として当てる', () => {
    const mapping = detectColumns(parseCsv(PAYPAY));
    expect(mapping.date).toBe(0);
    expect(mapping.amount).toBe(1);
    expect(mapping.refund).toBe(2);
    // 「取引内容」ではなく「取引先」を店名にする
    expect(mapping.merchant).toBe(5);
  });

  it('ヘッダの無い CSV は値の形から当てる', () => {
    const mapping = detectColumns(parseCsv(HEADERLESS));
    expect(mapping.headerRowIndex).toBe(-1);
    expect(mapping.date).toBe(0);
    expect(mapping.merchant).toBe(1);
    expect(mapping.amount).toBe(2);
  });

  it('支出がマイナスで入る形式を見分ける', () => {
    const rows = parseCsv(['日付,内容,金額', '2026/09/01,セブン,-1200', '2026/09/02,ローソン,-800'].join('\n'));
    expect(detectColumns(rows).sign).toBe('negative-expense');
  });

  it('空の入力でも落ちない', () => {
    const mapping = detectColumns([]);
    expect(isMappingComplete(mapping)).toBe(false);
  });
});
