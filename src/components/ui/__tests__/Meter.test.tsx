import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Meter, meterStatus } from '../Meter';

describe('meterStatus', () => {
  it('上限に対する消化で段階が変わる', () => {
    expect(meterStatus(1000, 0)).toBe('none');
    expect(meterStatus(7900, 10_000)).toBe('good');
    expect(meterStatus(9000, 10_000)).toBe('warning');
    expect(meterStatus(10_000, 10_000)).toBe('warning');
    expect(meterStatus(12_000, 10_000)).toBe('serious');
    expect(meterStatus(20_000, 10_000)).toBe('critical');
  });
});

describe('Meter', () => {
  it('色だけに頼らず、状態を文字でも出す', () => {
    render(<Meter label="食費" actual={12_000} limit={10_000} />);
    expect(screen.getByText('食費')).toBeInTheDocument();
    expect(screen.getByText('超過')).toBeInTheDocument();
    expect(screen.getByText('上限 ¥10,000 / 超過 ¥2,000')).toBeInTheDocument();
  });

  it('上限が未設定なら残額の代わりに補足を出す', () => {
    render(<Meter label="酒" actual={3_000} limit={0} detail="着地見込み ¥6,000" />);
    expect(screen.getByText('上限なし')).toBeInTheDocument();
    expect(screen.getByText('着地見込み ¥6,000')).toBeInTheDocument();
  });
});

describe('Meter の棒の形', () => {
  /** 棒の幅は style から読む。超過したときに「半分は上限内」と読めてしまう形を避けたい */
  function widths(actual: number, limit: number): string[] {
    const { container } = render(<Meter label="食費" actual={actual} limit={limit} />);
    return [...container.querySelectorAll('div[role=presentation] > div')].map(
      (element) => (element as HTMLElement).style.width,
    );
  }

  it('上限内なら 1 本で、長さは上限に対する割合', () => {
    expect(widths(5_000, 10_000)).toEqual(['50%']);
  });

  it('超過したら満杯にして、上限の位置で区切る', () => {
    // 3,000 の上限で 11,000 使った。上限の位置は 11,000 のうち 3,000 の場所
    const [within, marker, excess] = widths(11_000, 3_000);
    expect(within).toBe(`${(3_000 / 11_000) * 100}%`);
    expect(marker).toBe('');
    expect(excess).toBe(`${(8_000 / 11_000) * 100}%`);
  });

  it('2 倍使ったときと 3 倍使ったときで区切りの位置が違う', () => {
    expect(widths(6_000, 3_000)[0]).not.toBe(widths(9_000, 3_000)[0]);
  });
});
