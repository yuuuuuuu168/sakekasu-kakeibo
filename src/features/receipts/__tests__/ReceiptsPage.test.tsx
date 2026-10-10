import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { StoreProvider } from '../../../api/store';
import { ReceiptsPage } from '../ReceiptsPage';

describe('ReceiptsPage', () => {
  it('撮る入力とは別に、カメラロールから選べる入力を持つ', () => {
    const { container } = render(
      <StoreProvider>
        <ReceiptsPage />
      </StoreProvider>,
    );
    const inputs = [...container.querySelectorAll<HTMLInputElement>('input[type="file"]')];
    expect(inputs).toHaveLength(2);

    const camera = inputs.find((input) => input.hasAttribute('capture'));
    expect(camera?.getAttribute('capture')).toBe('environment');

    // capture が付いているとスマホはカメラしか開かない
    const library = inputs.find((input) => !input.hasAttribute('capture'));
    expect(library?.accept).toBe('image/jpeg,image/png,image/webp');
  });
});
