// Auto-discovers every page component in this directory and builds the routes
// array from it. Each page self-registers by exporting a `path` (and optional
// `authRequired` / `requiredAuthLevel`) as static properties on its default
// export — there is no central route table to maintain.
const files = import.meta.glob('./*.vue', { eager: true });

const modules = {};

for (const key in files) {
	modules[key.replace(/(\.\/|\.vue)/g, '')] = files[key];
}

const routes = [];
for (let key in modules) {
	routes.push({
		path: modules[key].default.path,
		component: modules[key].default,
		meta: {
			authRequired: modules[key].default.authRequired,
			requiredAuthLevel: modules[key].default.requiredAuthLevel,
		},
	});
}

export default routes;
