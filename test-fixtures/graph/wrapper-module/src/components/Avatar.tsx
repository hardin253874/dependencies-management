import * as http from '../lib/http';

export const Avatar = () => {
  void http.get('/avatar');
  return null;
};
