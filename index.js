import { Router } from "itty-router";
import { error, json, missing } from 'itty-router-extras'
import { createCors } from "itty-cors";

const Cache = caches.default;

// Create a new router
const router = Router();

const { preflight, corsify } = createCors();
router.all("*", preflight);

let privateKey, publicKey;

const algorithm = {
  name: "ECDSA",
  namedCurve: "P-384",
  hash: { name: "SHA-384" },
};

function toHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function toBuffer(hex) {
  return Uint8Array.from(hex.match(/../g).map((b) => parseInt(b, 16))).buffer;
}

async function withKeys(req, env) {
  if (privateKey) return;
  const privateKeyJWK = await env.KV.get("customixer:private_key");

  if (privateKeyJWK) {
    privateKey = await crypto.subtle.importKey(
      "jwk",
      JSON.parse(privateKeyJWK),
      algorithm,
      true,
      ["sign"],
    );
    const publicKeyJWK = await env.KV.get("customixer:public_key");
    publicKey = await crypto.subtle.importKey(
      "jwk",
      JSON.parse(publicKeyJWK),
      algorithm,
      true,
      ["verify"],
    );
  } else {
    const keyPair = await crypto.subtle.generateKey(
      algorithm,
      true,
      ["sign", "verify"],
    );
    privateKey = keyPair.privateKey;
    publicKey = keyPair.publicKey;
    const _privateKey = await crypto.subtle.exportKey(
      "jwk",
      keyPair.privateKey,
    );
    const _publicKey = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
    await env.KV.put(
      "customixer:private_key",
      JSON.stringify(_privateKey, null, 2),
    );
    await env.KV.put(
      "customixer:public_key",
      JSON.stringify(_publicKey, null, 2),
    );
  }
}

/*
Our index route, a simple hello world.
*/
router.get("/", async (req, env) => {
  return new Response(
    "Hello, world! This is the root page of your Worker template.",
  );
});

/*
This route demonstrates path parameters, allowing you to extract fragments from the request
URL.

Try visit /example/hello and see the response.
*/
router.get("/example/:text", ({ params }) => {
  // Decode text like "Hello%20world" into "Hello world"
  let input = decodeURIComponent(params.text);

  // Serialise the input into a base64 string
  let base64 = btoa(input);

  // Return the HTML with the string to the client
  return new Response(`<p>Base64 encoding: <code>${base64}</code></p>`, {
    headers: {
      "Content-Type": "text/html",
    },
  });
});

/*
This shows a different HTTP method, a POST.

Try send a POST request using curl or another tool.

Try the below curl command to send JSON:

$ curl -X POST <worker> -H "Content-Type: application/json" -d '{"abc": "def"}'
*/
router.post("/post", async (request) => {
  // Create a base object with some fields.
  let fields = {
    asn: request.cf.asn,
    colo: request.cf.colo,
  };

  // If the POST data is JSON then attach it to our response.
  if (request.headers.get("Content-Type") === "application/json") {
    let json = await request.json();
    Object.assign(fields, { json });
  }

  // Serialise the JSON to a string.
  const returnData = JSON.stringify(fields, null, 2);

  return json(returnData);
});

router.get(
  "/customizer/:script.stl",
  withKeys,
  async (request, env, context) => {
    const { script } = request.params;
    const { query } = request;

    const url = new URL("https://customizer-xdtwgffqpa-uc.a.run.app/");
    url.searchParams.set("script", script);
    Object.entries(query).forEach(([key, value]) =>
      url.searchParams.set(key, value)
    );
    if (script === "cacti") {
      if (!url.searchParams.has("cacti_seed")) {
        url.searchParams.set("cacti_seed", Math.random());
      }
    }

    const urlRequest = url.toString();

    const cacheResponse = await Cache.match(urlRequest);
    console.log(`Cache ${cacheResponse ? "" : "not "}found`, url);
    const fileResponse = cacheResponse ? undefined : await fetch(url);

    const [body, bodyCopy] = cacheResponse?.body.tee() ??
      fileResponse?.body.tee();

    const res = new Response(body, cacheResponse ?? fileResponse);
    if (fileResponse) {
      const uuid = crypto.randomUUID();
      res.headers.set(
        "Content-Disposition",
        `attachment; filename="${script}-${uuid}.stl"`,
      );
      res.headers.set("Cache-Control", "public, max-age=604800");
      context.waitUntil(env.KV.put(`${script}-${uuid}`, urlRequest));
      if (script === "cacti" && "cacti_seed" in query) {
        const newRes = new Response(bodyCopy, res);
        context.waitUntil(Cache.put(urlRequest, newRes));
      }
    }

    return res;
  },
);

router.post(
  "/customizer/upload/:key/:signature",
  withKeys,
  async (request, env) => {
    const { key, signature: signature_string } = request.params;

    let verified;

    try {
      const signature = toBuffer(signature_string);
      verified = await crypto.subtle.verify(
        algorithm,
        publicKey,
        signature,
        new TextEncoder().encode(key),
      );
      if (verified) await env.R2.put(key, request.body);
    } catch (e) {
      console.error(e);
      return new Response(null, { status: 500 });
    }

    return new Response(null, { status: verified ? 200 : 404 });
  },
);
/*
This is the last route we define, it will match anything that hasn't hit a route we've defined
above, therefore it's useful as a 404 (and avoids us hitting worker exceptions, so make sure to include it!).

Visit any page that doesn't exist (e.g. /foobar) to see it in action.
*/
router.all("*", () => missing("404, not found!"));

export default {
  fetch: (...args) => router
                        .handle(...args)
                        .catch(err => error(500, err.stack))
                        .then(corsify) // cors should be applied to error responses as well
}