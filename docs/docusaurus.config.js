module.exports = {
  title: 'Volodyslav Documentation',
  tagline: 'Documentation for the Volodyslav project',
  url: 'https://example.com',
  baseUrl: '/',
  onBrokenLinks: 'warn',
  onBrokenMarkdownLinks: 'warn',
  favicon: 'img/favicon.ico',
  organizationName: 'volodyslav',
  projectName: 'docs',
  presets: [
    [
      'classic',
      {
        docs: {
          routeBasePath: '/',
          sidebarPath: require.resolve('./sidebars.js'),
          path: '.',
        },
        blog: false,
      },
    ],
  ],
};
