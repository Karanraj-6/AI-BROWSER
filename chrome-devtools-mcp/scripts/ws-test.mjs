import {WebSocket} from 'ws';

const socket = new WebSocket('ws://127.0.0.1:8080');

socket.on('open', () => {
  console.log('connected');
  socket.send(JSON.stringify({jsonrpc: '2.0', id: 1, method: 'ping'}));
});

socket.on('message', data => {
  console.log('message', data.toString());
});

socket.on('close', () => {
  console.log('closed');
  process.exit(0);
});

socket.on('error', err => {
  console.error('error', err);
  process.exit(1);
});

setTimeout(() => {
  console.log('timeout closing');
  socket.close();
}, 1000);
