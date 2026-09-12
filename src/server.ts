import { loadConfig } from './config.js';
import { createApp } from './http/app.js';

try {
  // Node lê .env nativamente. Em container não existe arquivo: o Coolify
  // injeta as vars direto no ambiente, então a ausência não é erro.
  process.loadEnvFile();
} catch {
  // segue com o que já estiver em process.env
}

const config = loadConfig();

const server = createApp(config).listen(config.port, config.host, () => {
  console.log(JSON.stringify({ level: 'info', msg: 'career-mcp listening', port: config.port }));
});

// Coolify manda SIGTERM no redeploy; drenar as conexões evita 502 no Traefik.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
