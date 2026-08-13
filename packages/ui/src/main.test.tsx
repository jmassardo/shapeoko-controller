import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { App, UI_PACKAGE_NAME } from './main.js';

describe('@shapeoko/ui smoke', () => {
  it('reports its package name', () => {
    expect(UI_PACKAGE_NAME).toBe('@shapeoko/ui');
  });

  it('renders the placeholder App component to markup', () => {
    const markup = renderToStaticMarkup(<App />);
    expect(markup).toContain('shapeoko-app');
    expect(markup).toContain('Shapeoko Controller');
  });
});
