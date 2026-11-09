import { $$, h, toast, mountShell } from './common.js';

await mountShell('docs');
for (const pre of $$('pre[data-copy]')) {
  pre.append(h('button', { class: 'copy', type: 'button', text: 'Copy', onclick: async () => {
    try {
      await navigator.clipboard.writeText(pre.firstChild.textContent);
      toast('Copied.');
    } catch {
      toast('Select the text and copy it by hand.');
    }
  } }));
}
