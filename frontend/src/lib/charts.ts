import { ArcElement, BarController, BarElement, CategoryScale, Chart as ChartJS, DoughnutController, Filler, Legend, LineController, LineElement, LinearScale, PointElement, Tooltip } from 'chart.js'

ChartJS.register(ArcElement, BarController, BarElement, CategoryScale, DoughnutController, Filler, Legend, LineController, LineElement, LinearScale, PointElement, Tooltip)

ChartJS.defaults.font.family = 'Manrope, sans-serif'
ChartJS.defaults.color = '#64748b'