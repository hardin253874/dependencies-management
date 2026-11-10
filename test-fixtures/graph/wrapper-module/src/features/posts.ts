import { get, post } from '../lib/http';

export const posts = () => get('/posts');
export const addPost = (p: unknown) => post('/posts', p);
