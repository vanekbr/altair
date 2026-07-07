// Minimal static file server with SPA fallback for serving the production build.
const http = require('http');
const fs = require('fs');
const path = require('path');

const distBrowser = path.resolve(__dirname, '../dist/browser');
const distRoot = path.resolve(__dirname, '../dist');
const root = require('fs').existsSync(distBrowser) ? distBrowser : distRoot;
const port = process.env.PORT ? Number(process.env.PORT) : 4200;

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

const send = (res, status, filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(status, { 'Content-Type': mime[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  let filePath = path.normalize(path.join(root, urlPath));

  // Prevent path traversal outside root.
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
    fs.stat(filePath, (err2, stat2) => {
      if (!err2 && stat2.isFile()) {
        return send(res, 200, filePath);
      }
      // SPA fallback: serve index.html for unknown non-asset routes.
      return send(res, 200, path.join(root, 'index.html'));
    });
  });
});

server.listen(port, () => {
  console.log(`Altair production build served at http://localhost:${port}/`);
  console.log(`Serving: ${root}`);
});
