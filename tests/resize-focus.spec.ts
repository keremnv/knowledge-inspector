import { test, expect } from '@playwright/test';

// World currently uses OverlayPanel. Exercise the other retained divider in
// an isolated browser harness too, including its CSS-variable preview contract.
test('retained panel divider: keyboard, pointer preview/commit, constraints and reset', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/keyboard-divider-harness', route => route.fulfill({ contentType: 'text/html', body: `
    <html><body style="--ink:#202020;--ink-muted:#777;--panel:#fff;--rule:#ddd"><div id="root"></div>
    <script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;
      window.__vite_plugin_react_preamble_installed__=true;
      const React=(await import('/node_modules/.vite/deps/react.js')).default;
      const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
      const {ResizableDivider}=await import('/src/world/WorldResize.tsx');
      function Harness(){
        const [size,setSize]=React.useState(240);
        return React.createElement('div',{style:{display:'grid',gridTemplateColumns:'var(--test-width) 9px 1fr',width:800,height:400,'--test-width':size+'px'}},
          React.createElement('section',{id:'test-pane'},'Panel'),
          React.createElement(ResizableDivider,{label:'Resize test panel',controls:'test-pane',size,defaultSize:240,minSize:160,maxSize:500,minTrailingSize:200,cssVariable:'--test-width',onResize:setSize}),
          React.createElement('output',null,size));
      }
      createRoot(document.getElementById('root')).render(React.createElement(Harness));
    </script></body></html>` }));
  await page.goto('/keyboard-divider-harness');
  const divider = page.getByRole('separator', { name: 'Resize test panel' });
  await expect(divider).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(divider).toBeFocused();
  expect(await divider.evaluate(e => getComputedStyle(e, '::after').borderInlineStartWidth)).toBe('2px');
  await expect(divider).toHaveAttribute('aria-orientation', 'vertical');
  await page.keyboard.press('ArrowRight');
  await expect(divider).toHaveAttribute('aria-valuenow', '256');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(divider).toHaveAttribute('aria-valuenow', '304');
  await page.keyboard.press('ArrowLeft');
  await expect(divider).toHaveAttribute('aria-valuenow', '288');
  await page.keyboard.press('Home');
  await expect(divider).toHaveAttribute('aria-valuenow', '160');
  await page.keyboard.press('End');
  await expect(divider).toHaveAttribute('aria-valuenow', '500');
  await divider.dblclick();
  await expect(divider).toHaveAttribute('aria-valuenow', '240');
  const box = (await divider.boundingBox())!;
  await page.mouse.move(box.x + 4, box.y + 100); await page.mouse.down();
  await page.mouse.move(box.x + 20, box.y + 100);
  await expect.poll(async () => (await page.locator('#test-pane').boundingBox())!.width).toBe(256);
  // The preview changes real geometry without committing React on each move.
  await expect(page.locator('output')).toHaveText('240');
  await page.mouse.up();
  await expect(page.locator('output')).toHaveText('256');
  await expect(page.locator('html')).not.toHaveClass(/is-panel-resizing/);
  expect(errors).toEqual([]);
});
