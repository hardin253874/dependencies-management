export const Home = () => import('./pages/Home');
export const locale = (l: string) => import(`./locales/${l}.json`);
export const lazyLodash = () => import('lodash-es');
