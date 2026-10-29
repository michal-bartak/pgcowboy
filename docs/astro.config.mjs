import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import starlightThemeRapide from 'starlight-theme-rapide';

// GitHub Pages: served at https://michal-bartak.github.io/pgcowboy/
// (base matches the repo name). Update both if the repo is renamed.
export default defineConfig({
  site: 'https://michal-bartak.github.io',
  base: '/pgcowboy',
  // Pages that moved when the docs were split into Usage / Configuration sections.
  redirects: {
    '/call-templates': '/pgcowboy/configuration/call-templates/',
    // Renamed when "Privileges" became "Role parents" in the UI. NOTE the destination carries the
    // `base` and the key does not: Astro prefixes the route it matches but emits the destination
    // verbatim, so a base-less destination sends GitHub Pages to a 404.
    '/usage/privileges': '/pgcowboy/usage/parent-roles/',
  },
  integrations: [
    starlight({
      title: 'pgCowboy',
      description: 'Maintain PostgreSQL roles across many clusters from one desktop app',
      plugins: [starlightThemeRapide()],
      // Restore Starlight's own theme picker: a labelled Dark/Light/Auto <select>.
      // starlight-theme-rapide replaces ThemeSelect with a sun/moon icon button whose click
      // handler only flips between dark and light, so "auto" (follow the OS) is unreachable once
      // you click it. Its overrideComponents() yields to an override declared here, logging one
      // build warning as it does so. NOTE that warning is expected, not a misconfiguration.
      // Header spacing then needs two rapide rules undone; see the theme-picker block in
      // src/styles/custom.css.
      components: {
        ThemeSelect: '@astrojs/starlight/components/ThemeSelect.astro',
      },
      // Renames the table-of-contents' top entry from "Overview" to the page title.
      routeMiddleware: './src/starlightRouteData.ts',
      favicon: '/appicon.png',
      logo: {
        src: './src/assets/appicon.png',
        alt: 'pgCowboy',
        replacesTitle: false,
      },
      social: { github: 'https://github.com/michal-bartak/pgcowboy' },
      customCss: ['./src/styles/custom.css'],
      // Click a screenshot in the docs body to view it full-size in a lightbox.
      // Runs on first load and after every Starlight client-side navigation.
      head: [
        {
          tag: 'script',
          content: `
            (function () {
              function overlay() {
                var el = document.getElementById('img-lightbox');
                if (el) return el;
                el = document.createElement('div');
                el.id = 'img-lightbox';
                el.className = 'img-lightbox';
                el.innerHTML = '<img alt="">';
                el.addEventListener('click', function () { el.classList.remove('open'); });
                document.addEventListener('keydown', function (e) {
                  if (e.key === 'Escape') el.classList.remove('open');
                });
                document.body.appendChild(el);
                return el;
              }
              function wire() {
                var imgs = document.querySelectorAll('.sl-markdown-content img');
                for (var i = 0; i < imgs.length; i++) {
                  (function (img) {
                    if (img.dataset.lightbox) return;
                    img.dataset.lightbox = '1';
                    img.addEventListener('click', function () {
                      var el = overlay();
                      var big = el.querySelector('img');
                      big.src = img.currentSrc || img.src;
                      big.alt = img.alt || '';
                      el.classList.add('open');
                    });
                  })(imgs[i]);
                }
              }
              document.addEventListener('DOMContentLoaded', wire);
              document.addEventListener('astro:page-load', wire);
            })();
          `,
        },
      ],
      sidebar: [
        { label: 'Overview', link: '/' },
        { label: 'Installation', link: '/installation/' },
        {
          label: 'Usage',
          items: [
            { label: 'Overview', link: '/usage/' },
            { label: 'Finding the role to alter', link: '/usage/find-role/' },
            { label: 'Renaming a role', link: '/usage/rename-role/' },
            { label: 'Altering the comment', link: '/usage/comments/' },
            { label: 'Altering role parents', link: '/usage/parent-roles/' },
            { label: 'Altering attributes', link: '/usage/attributes/' },
            { label: 'Altering settings', link: '/usage/role-settings/' },
            { label: 'Setting a password', link: '/usage/password/' },
            { label: 'Where a role exists', link: '/usage/presence/' },
            { label: 'Creating a role', link: '/usage/creating-roles/' },
            { label: 'Command log', link: '/usage/command-log/' },
          ],
        },
        {
          label: 'Configuration',
          items: [
            { label: 'Overview', link: '/configuration/' },
            { label: 'Clusters', link: '/configuration/clusters/' },
            { label: 'Comment fields', link: '/configuration/comment-fields/' },
            { label: 'Role Details', link: '/configuration/role-details/' },
            { label: 'Call templates', link: '/configuration/call-templates/' },
            { label: 'Preconfigured role parents', link: '/configuration/parent-roles/' },
            { label: 'Password generator', link: '/configuration/password-generator/' },
            { label: 'General settings', link: '/configuration/general/' },
          ],
        },
        { label: 'Troubleshooting', link: '/troubleshooting/' },
        { label: 'Building from source', link: '/building/' },
        { label: 'Credits', link: '/credits/' },
      ],
    }),
  ],
});
