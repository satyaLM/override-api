import { Client } from 'ssh2';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

export async function startTunnel() {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => {
      console.log('SSH tunnel established (localhost:5433 → 10.10.7.27:5432)');
      conn.forwardOut(
        '127.0.0.1',
        5433,
        '10.10.7.27',
        5432,
        (err, stream) => {
          if (err) {
            console.error('SSH tunnel forwarding failed:', err.message, err.stack);
            conn.end();
            reject(err);
          } else {
            resolve(conn);
          }
        }
      );
    })
    .on('error', (err) => {
      console.error('SSH connection failed:', err.message, err.stack);
      reject(err);
    })
    .on('close', () => {
      console.log('SSH tunnel closed');
    })
    .connect({
      host: 'ec2-65-2-95-216.ap-south-1.compute.amazonaws.com',
      port: 22,
      username: 'ubuntu',
      privateKey: fs.readFileSync('/home/satyanarayan/Downloads/hop_server-dt1_dev_aps1.pem'),
      keepaliveInterval: 10000,
      keepaliveCountMax: 3
    });
  });
}