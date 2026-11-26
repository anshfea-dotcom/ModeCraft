const fs = require('node:fs');
const path = require('node:path');
const template = fs.readFileSync(path.join(__dirname, '../../views/account.html'), 'utf8');

module.exports = function registerAccountPages(app) {
  const pages = [
    ['/login.html', 'login', 'Welcome back'],
    ['/signup.html', 'signup', 'Create your account'],
    ['/reset-password.html', 'reset', 'Reset your password']
  ];
  for (const [url, page, title] of pages) {
    const html = template.replaceAll('{{page}}', page).replaceAll('{{title}}', title);
    app.get(url, (_req, res) => res.type('html').send(html));
  }
};
