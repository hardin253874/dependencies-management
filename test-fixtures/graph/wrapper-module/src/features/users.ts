import { get } from '../lib/http';

export const users = () => get('/users');
