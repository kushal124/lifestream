// @ts-check

const STYLES = ['cockpit.css', 'kit.css', 'shell.css', 'moment.css', 'ask.css', 'days.css', 'days-side.css', 'people.css',
  'places.css', 'search.css', 'connectors.css', 'flows.css', 'onboarding.css'];

const theme = localStorage.getItem('theme');
if (theme) document.documentElement.dataset.theme = theme;
await Promise.all(STYLES.map(href => new Promise(resolve => {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.addEventListener('load', resolve);
  link.addEventListener('error', resolve);
  document.head.append(link);
})));
await import('./main.js');
