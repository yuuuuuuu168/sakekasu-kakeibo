import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ActionErrorProvider } from '../../components/ActionErrorProvider';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { useAction, useActionError } from '../action';

function Probe({ action }: { action: () => Promise<unknown> }) {
  const run = useAction();
  const error = useActionError();
  return (
    <div>
      <button type="button" onClick={() => void run(action)}>
        保存
      </button>
      {error && (
        <p role="alert">
          {error.message}
          <button type="button" onClick={error.dismiss}>
            閉じる
          </button>
        </p>
      )}
    </div>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useAction', () => {
  it('失敗したら理由を帯に出し、閉じれば消える', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ActionErrorProvider>
        <Probe action={async () => Promise.reject(new Error('API がエラーを返しました (500)'))} />
      </ActionErrorProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('API がエラーを返しました (500)');

    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('成功したら何も出さない', async () => {
    render(
      <ActionErrorProvider>
        <Probe action={async () => undefined} />
      </ActionErrorProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存' }));
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('Provider の外でも例外を外に漏らさず、コンソールに出す', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<Probe action={async () => Promise.reject(new Error('落ちた'))} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存' }));
    });
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ message: '落ちた' }));
  });
});

describe('ErrorBoundary', () => {
  function Broken(): never {
    throw new Error('描けない');
  }

  it('描画の例外で白い画面にせず、理由を出す', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ErrorBoundary>
        <Broken />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('この画面を表示できませんでした。描けない');
  });
});
