/* ============================================================
   CHARTS, Gráficos com Chart.js
   ============================================================ */

const ChartsModule = (() => {

  const COLOR = {
    primary:   '#00d4aa',
    secondary: '#6c8cff',
    user:      '#6c8cff',
    assistant: '#ffa726',
    grid:      'rgba(255,255,255,0.06)',
    text:      '#97a4ba',
    border:    '#25344f',
    contextLine: '#ff5252',
  };

  // Defaults globais (uma vez)
  function setGlobalDefaults() {
    if (typeof Chart === 'undefined') return;
    Chart.defaults.font.family = '"Manrope", system-ui, sans-serif';
    Chart.defaults.color = COLOR.text;
    Chart.defaults.borderColor = COLOR.grid;
  }
  setGlobalDefaults();

  let growthChart = null;
  let barsChart = null;

  function initGrowthChart(canvas) {
    if (growthChart) growthChart.destroy();
    growthChart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: 'Tokens acumulados',
            data: [],
            borderColor: COLOR.primary,
            backgroundColor: 'rgba(0,212,170,0.12)',
            fill: true,
            tension: 0.25,
            borderWidth: 2,
            pointRadius: 4,
            pointHoverRadius: 6,
            pointBackgroundColor: COLOR.primary,
          },
        ],
      },
      options: chartOptions('Mensagem', 'Tokens acumulados'),
    });
  }

  function initBarsChart(canvas) {
    if (barsChart) barsChart.destroy();
    barsChart = new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: [],
        datasets: [
          {
            label: 'Usuário',
            data: [],
            backgroundColor: COLOR.user,
            borderRadius: 4,
          },
          {
            label: 'Assistente',
            data: [],
            backgroundColor: COLOR.assistant,
            borderRadius: 4,
          },
        ],
      },
      options: chartOptions('Mensagem', 'Tokens', true),
    });
  }

  function chartOptions(xLabel, yLabel, showLegend = false) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 250 },
      plugins: {
        legend: {
          display: showLegend,
          position: 'top',
          align: 'end',
          labels: { boxWidth: 12, boxHeight: 12, font: { size: 11 } },
        },
        tooltip: {
          backgroundColor: '#1a2540',
          titleColor: '#e8eef5',
          bodyColor: '#e8eef5',
          borderColor: COLOR.border,
          borderWidth: 1,
          padding: 10,
          titleFont: { size: 12, weight: 'bold' },
          bodyFont: { size: 12, family: 'JetBrains Mono' },
        },
      },
      scales: {
        x: {
          title: { display: true, text: xLabel, color: COLOR.text, font: { size: 11 } },
          grid: { color: COLOR.grid, drawBorder: false },
          ticks: { color: COLOR.text, font: { size: 11 } },
        },
        y: {
          beginAtZero: true,
          title: { display: true, text: yLabel, color: COLOR.text, font: { size: 11 } },
          grid: { color: COLOR.grid, drawBorder: false },
          ticks: { color: COLOR.text, font: { size: 11, family: 'JetBrains Mono' } },
        },
      },
    };
  }

  function updateGrowth(history) {
    if (!growthChart) return;
    growthChart.data.labels = history.map((_, i) => `${i + 1}`);
    growthChart.data.datasets[0].data = history.map(m => m.cumulativeTokens);
    growthChart.update();
  }

  function updateBars(history) {
    if (!barsChart) return;
    const labels = history.map((_, i) => `${i + 1}`);
    const userData = history.map(m => m.role === 'user' ? m.totalTokens : null);
    const asstData = history.map(m => m.role === 'assistant' ? m.totalTokens : null);
    barsChart.data.labels = labels;
    barsChart.data.datasets[0].data = userData;
    barsChart.data.datasets[1].data = asstData;
    barsChart.update();
  }

  return {
    initGrowthChart, initBarsChart, updateGrowth, updateBars,
  };
})();

window.ChartsModule = ChartsModule;
