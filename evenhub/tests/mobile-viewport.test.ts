import { describe, expect, it, vi } from 'vitest';

import { trackVisualViewport } from '../src/ui';

describe('iOS keyboard viewport tracking', () => {
  it('resizes the companion to the live visual viewport and cleans up listeners', () => {
    const listeners = new Map<string, () => void>();
    const viewport = {
      height: 844,
      offsetTop: 0,
      addEventListener: vi.fn((type: string, listener: () => void) => {
        listeners.set(type, listener);
      }),
      removeEventListener: vi.fn((type: string) => listeners.delete(type)),
    };
    const properties = new Map<string, string>();
    const style = {
      setProperty: vi.fn((name: string, value: string) => {
        properties.set(name, value);
      }),
    };
    const onChange = vi.fn();

    const stop = trackVisualViewport(style, viewport, onChange);
    expect(properties).toMatchObject(
      new Map([
        ['--visual-viewport-height', '844px'],
        ['--visual-viewport-top', '0px'],
      ]),
    );

    viewport.height = 412;
    viewport.offsetTop = 18;
    listeners.get('resize')?.();
    expect(properties.get('--visual-viewport-height')).toBe('412px');
    expect(properties.get('--visual-viewport-top')).toBe('18px');
    expect(onChange).toHaveBeenCalledTimes(2);

    stop();
    expect(viewport.removeEventListener).toHaveBeenCalledWith(
      'resize',
      expect.any(Function),
    );
    expect(viewport.removeEventListener).toHaveBeenCalledWith(
      'scroll',
      expect.any(Function),
    );
  });
});
