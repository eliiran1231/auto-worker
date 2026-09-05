export interface Repository {
  id: number;
  clone_url: string;
  name: string;
  owner: { login: string };
}
