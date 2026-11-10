import axios from 'axios';

export const get = (url: string) => axios.get(url);
export const post = (url: string, body: unknown) => axios.post(url, body);
