const express = require('express');
const cors = require('cors');
const path = require('path');

// Simulación de carga de tu lógica existente
const signalManager = require('./electron/signal-manager');
const trayManager = require('./electron/tray-manager');

const app = express();
app.use(cors());
app.use(express.json());

// Ruta de prueba
app.get('/', (req, res) => {
  res.send('SAITRAPP Backend está activo ✅');
});

// Puerto dinámico para Railway o local
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Backend SAITRAPP activo en el puerto ${PORT}`);
});
