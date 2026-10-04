/**
 * Every collection of this application, in one module: `defineMongo` takes
 * this object, and the Mongo's `db.users` and `db.articles` come from the
 * names they are exported under. Each module keeps its own model beside its
 * service and its routes; this is only where they meet the Mongo.
 */
export { articles } from './modules/articles/articles.model';
export { users } from './modules/users/users.model';
