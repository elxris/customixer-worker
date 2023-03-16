import { Router } from "itty-router";
import { error, json, missing } from "itty-router-extras";
import { createCors } from "itty-cors";

const Cache = caches.default;

// Create a new router
const router = Router();

const { preflight, corsify } = createCors();
router.all("*", preflight);

async function withCustomizerUrl(request, env, context) {
  const { script } = request.params;
  const { query } = request;

  const _url = new URL("https://customizer-xdtwgffqpa-uc.a.run.app/");
  _url.searchParams.set("script", script);
  Object.entries(query).forEach(([key, value]) =>
    _url.searchParams.set(key, value)
  );
  if (script === "cacti") {
    if (!_url.searchParams.has("cacti_seed")) {
      _url.searchParams.set("cacti_seed", Math.random());
    }
  }

  request.customizerUrl = _url.toString();
}

router.get(
  "/customizer/:script.stl",
  withCustomizerUrl,
  async (request, env, context) => {
    const { script } = request.params;
    const { query, customizerUrl: url } = request;

    const cacheResponse = await Cache.match(url);
    console.log(`Cache ${cacheResponse ? "" : "not "}found`, url);
    const fileResponse = cacheResponse ? undefined : await fetch(url, {
      headers: { "Accept-Encoding": "gzip, deflate, br" },
    });

    const [body, bodyCopy] = cacheResponse?.body.tee() ??
      fileResponse?.body.tee();

    const res = new Response(body, cacheResponse ?? fileResponse);
    if (fileResponse) {
      const uuid = crypto.randomUUID();
      res.headers.set(
        "Content-Disposition",
        `attachment; filename="${script}-${uuid}.stl"`,
      );
      res.headers.set(
        "Content-Type",
        "text/plain",
      );
      res.headers.set("Cache-Control", "public, max-age=604800");
      // context.waitUntil(env.KV.put(`${script}-${uuid}`, url));
      if (script === "cacti" && "cacti_seed" in query) {
        const newRes = new Response(bodyCopy, res);
        context.waitUntil(Cache.put(url, newRes));
      }
    }

    if (!("cacti_seed" in query)) {
      res.headers.delete("Cache-Control");
    }

    return res;
  },
);

/*
This is the last route we define, it will match anything that hasn't hit a route we've defined
above, therefore it's useful as a 404 (and avoids us hitting worker exceptions, so make sure to include it!).

Visit any page that doesn't exist (e.g. /foobar) to see it in action.
*/
router.all("*", () => missing("404, not found!"));

export default {
  fetch: (...args) =>
    router
      .handle(...args)
      .catch((err) => error(500, err.stack))
      .then(corsify), // cors should be applied to error responses as well
};
