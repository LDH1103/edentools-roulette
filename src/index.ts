import './localization';
import { initApp } from './app';
import { Roulette } from './roulette';

const roulette = new Roulette();
(window as any).roulette = roulette;

initApp(roulette);
