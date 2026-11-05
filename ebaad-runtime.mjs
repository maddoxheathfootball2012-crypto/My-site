import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const MAGIC = Buffer.from('EBAAD\x02\x00\x00');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8'
};

function readPackage(packagePath, publicKeyPem) {
  const buffer = fs.readFileSync(packagePath);
  if (buffer.length < 12 || !buffer.subarray(0, 8).equals(MAGIC)) {
    throw new Error('Invalid package format');
  }

  const headerLen = buffer.readUInt32BE(8);
  const headerJsonStr = buffer.toString('utf8', 12, 12 + headerLen);
  const header = JSON.parse(headerJsonStr);
  const signature = header.signature;

  const headerWithoutSig = { ...header };
  delete headerWithoutSig.signature;
  const headerWithoutSigBuf = Buffer.from(JSON.stringify(headerWithoutSig), 'utf8');
  const ciphertext = buffer.subarray(12 + headerLen);
  const signData = Buffer.concat([headerWithoutSigBuf, ciphertext]);

  if (publicKeyPem) {
    const verified = crypto.verify(null, signData, publicKeyPem, Buffer.from(signature, 'base64'));
    if (!verified) {
      throw new Error('Package signature verification failed');
    }
  }

  return {
    header,
    ciphertext,
    iv: Buffer.from(header.nonce, 'base64'),
    authTag: Buffer.from(header.authTag, 'base64')
  };
}

function decryptPackage(packageData, keyBuffer) {
  const { ciphertext, iv, authTag } = packageData;
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer, iv);
  decipher.setAuthTag(authTag);
  const deflated = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const inflated = zlib.inflateSync(deflated);

  const files = {};
  let offset = 0;
  while (offset < inflated.length) {
    const pLen = inflated.readUInt16BE(offset);
    const dLen = inflated.readUInt32BE(offset + 2);
    offset += 6;
    const rel = inflated.toString('utf8', offset, offset + pLen);
    offset += pLen;
    const data = inflated.subarray(offset, offset + dLen);
    offset += dLen;
    files[rel] = data;
  }
  return files;
}

export class EbaadRuntime {
  constructor(options = {}) {
    this.rootDir = options.rootDir || process.cwd();
    this.configFile = options.configFile || path.join(this.rootDir, 'config.json');
    this.packageFile = options.packageFile || path.join(this.rootDir, 'app.ebaad');
    this.publicKeyPem = options.publicKeyPem || this.loadPublicKey();

    this.config = this.loadConfig();
    this.state = 'INITIALIZING';
    this.files = {};
    this.currentLease = null;
    this.checkTimer = null;
  }

  loadPublicKey() {
    const keyPath = path.join(this.rootDir, 'public.pem');
    if (fs.existsSync(keyPath)) {
      return fs.readFileSync(keyPath, 'utf8');
    }
    return null;
  }

  loadConfig() {
    if (!fs.existsSync(this.configFile)) {
      throw new Error('Configuration file missing');
    }
    return JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
  }

  async sendRequest(targetUrl, body = null) {
    const u = new URL(targetUrl);
    const isHttps = u.protocol === 'https:';
    const client = isHttps ? https : http;

    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: body ? 'POST' : 'GET',
      headers: {
        'Accept': 'application/json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {})
      },
      timeout: 8000
    };

    return new Promise((resolve, reject) => {
      const req = client.request(options, (res) => {
        let buf = '';
        res.on('data', chunk => buf += chunk);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(buf) });
          } catch {
            resolve({ status: res.statusCode, data: buf });
          }
        });
      });
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Connection timed out'));
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  verifyResponseSignature(payload, signatureBase64) {
    if (!this.publicKeyPem || !signatureBase64) return true;
    try {
      const data = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
      return crypto.verify(null, data, this.publicKeyPem, Buffer.from(signatureBase64, 'base64'));
    } catch {
      return false;
    }
  }

  async activate() {
    const { licenceKey, licenceApiUrl } = this.config;
    const nonce = crypto.randomBytes(16).toString('hex');

    const res = await this.sendRequest(`${licenceApiUrl}/api/activate`, {
      licenceKey,
      nonce
    });

    if (res.status !== 200 || !res.data || !res.data.success) {
      this.state = res.data?.status || 'REVOKED';
      throw new Error(res.data?.error || 'Licence activation failed');
    }

    if (res.data.signature) {
      const valid = this.verifyResponseSignature(res.data.leasePayload, res.data.signature);
      if (!valid) {
        throw new Error('Invalid signature on authorisation response');
      }
    }

    const keyBuffer = Buffer.from(res.data.packageKey, 'base64');
    const pkgData = readPackage(this.packageFile, this.publicKeyPem);
    this.files = decryptPackage(pkgData, keyBuffer);

    this.state = 'ACTIVE';
    this.currentLease = {
      expiresAt: res.data.expiresAt,
      leasePayload: res.data.leasePayload
    };

    this.startPeriodicValidation();
  }

  async validate() {
    const { licenceKey, licenceApiUrl } = this.config;
    const nonce = crypto.randomBytes(16).toString('hex');

    try {
      const res = await this.sendRequest(`${licenceApiUrl}/api/validate`, {
        licenceKey,
        nonce
      });

      if (res.status === 200 && res.data && res.data.success) {
        if (res.data.signature) {
          const valid = this.verifyResponseSignature(res.data.leasePayload, res.data.signature);
          if (!valid) {
            this.state = 'REVOKED';
            return;
          }
        }

        const newStatus = res.data.status;
        if (newStatus === 'ACTIVE') {
          this.state = 'ACTIVE';
          this.currentLease = {
            expiresAt: res.data.expiresAt,
            leasePayload: res.data.leasePayload
          };
        } else if (newStatus === 'DISABLED') {
          this.state = 'DISABLED';
        } else {
          this.state = 'REVOKED';
        }
      } else {
        if (res.data && res.data.status) {
          this.state = res.data.status;
        } else {
          this.handleOutage();
        }
      }
    } catch {
      this.handleOutage();
    }
  }

  handleOutage() {
    const now = Date.now();
    if (this.currentLease && now < this.currentLease.expiresAt) {
      return;
    }
    this.state = 'DISABLED';
  }

  startPeriodicValidation() {
    if (this.checkTimer) clearInterval(this.checkTimer);
    this.checkTimer = setInterval(() => {
      this.validate().catch(() => {});
    }, 60 * 1000);
  }

  createHandler() {
    return (req, res) => {
      if (this.state === 'REVOKED') {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Access Revoked');
        return;
      }

      if (this.state === 'DISABLED') {
        res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!DOCTYPE html><html><body style="font-family:sans-serif;background:#0f172a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div style="text-align:center;"><h2>Service Temporarily Suspended</h2><p>Please contact your administrator.</p></div></body></html>');
        return;
      }

      let parsedPath = req.url.split('?')[0];
      if (parsedPath === '/' || parsedPath === '') parsedPath = '/index.html';
      const cleanPath = parsedPath.startsWith('/') ? parsedPath.slice(1) : parsedPath;

      let fileBuffer = this.files[cleanPath] || this.files['public/' + cleanPath];

      if (!fileBuffer && !path.extname(cleanPath)) {
        fileBuffer = this.files['index.html'] || this.files['public/index.html'];
        parsedPath = '/index.html';
      }

      if (!fileBuffer) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }

      const ext = path.extname(parsedPath).toLowerCase();
      let contentType = MIME_TYPES[ext] || 'application/octet-stream';

      if (ext === '.html') {
        const injectedConfig = `<script>window.__EBAAD_CONFIG__ = ${JSON.stringify({
          wispUrl: this.config.wispUrl,
          licenceKey: this.config.licenceKey
        })};</script>`;
        const htmlStr = fileBuffer.toString('utf8').replace('<head>', '<head>' + injectedConfig);
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': Buffer.byteLength(htmlStr)
        });
        res.end(htmlStr);
        return;
      }

      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': fileBuffer.length
      });
      res.end(fileBuffer);
    };
  }

  listen(port = 8080) {
    const handler = this.createHandler();
    const server = http.createServer(handler);
    return new Promise((resolve) => {
      server.listen(port, () => resolve(server));
    });
  }

  stop() {
    if (this.checkTimer) clearInterval(this.checkTimer);
  }
}
