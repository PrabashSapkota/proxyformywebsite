export default async function handler(req, res) {
try {
const url = req.query.url;
if (!url) {
return res.status(400).send('Missing url parameter');
}


const response = await fetch(url, {
headers: {
'User-Agent': 'Mozilla/5.0',
},
});


res.setHeader('Access-Control-Allow-Origin', '*');
res.setHeader('Content-Type', response.headers.get('content-type'));


const body = await response.arrayBuffer();
res.send(Buffer.from(body));
} catch (err) {
res.status(500).send('Error: ' + err.message);
}
}