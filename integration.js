'use strict';

const _ = require('lodash');

const { setLogger, getLogger } = require('./src/logger');
const { polarityRequest } = require('./src/polarity-request');
const { parseErrorToReadableJSON, AuthRequestError } = require('./src/errors');
const { PolarityResult } = require('./src/create-result-object');
const NodeCache = require('node-cache');

// Default session timeout is 24 hours
const cookieCache = new NodeCache({ stdTTL: 86400 });

function startup(logger) {
  setLogger(logger);
}

async function doLookup(entities, options, cb) {
  const Logger = getLogger();

  Logger.trace({ entities, options }, 'doLookup');

  polarityRequest.setOptions(options);

  polarityRequest.setHeaders('Content-Type', 'application/json');
  polarityRequest.setHeaders('Accept', 'application/json');

  try {
    await authenticateAndSetHeaders(options);
    let searchResponse = await sendRequests(entities, options);
    Logger.trace({ searchResponse }, 'Search Response');

    // Check each response for a 401 status code
    const hasAuthError = searchResponse.some(
      (response) => _.get(response, '[0].result.statusCode') === 401
    );

    if (hasAuthError) {
      Logger.trace('Reauthenticating...');
      await authenticateAndSetHeaders(options, true); // Reattempt authentication
      searchResponse = await sendRequests(entities, options); // Retry the requests
    }

    const data = processApiResponse(searchResponse);

    const polarityResult = new PolarityResult();

    const lookupResults = data.map((result) => {
      if (result.isMiss) {
        return polarityResult.createNoResultsObject(result.entity);
      } else {
        const preprocessedData = buildResultObject(result, options);
        return polarityResult.createResultsObject(preprocessedData);
      }
    });

    Logger.trace({ lookupResults }, 'Lookup Results');

    return cb(null, lookupResults);
  } catch (err) {
    Logger.error({ err }, 'Error in doLookup');
    return cb(parseErrorToReadableJSON(err));
  }
}

function getCookieCacheKey(options) {
  return `${options.url}${options.username}${options.password}`;
}

async function authenticateAndSetHeaders(options, isRetryAttempt = false) {
  const Logger = getLogger();
  let session;
  let cookieCacheKey = getCookieCacheKey(options);
  if (isRetryAttempt) {
    // This is a retry attempt so the session cookie is no longer valid and we should delete if it
    // exists in the cache
    Logger.trace({ cookieCacheKey }, 'Deleting cached session cookie');
    cookieCache.del(cookieCacheKey);
  } else {
    // Not a retry attempt so check to see if we have a cached session key
    session = cookieCache.get(cookieCacheKey);
  }

  if (session) {
    Logger.trace({ session }, 'Using cached session cookie');
    polarityRequest.setHeaders('Cookie', session);
    return;
  }

  try {
    const authResponse = await auth(options);

    // If this is a retry attempt then we want to fail if the authentication did not work
    // Our normal request code does not fail on a 401 specifically because we want to allow
    // a re-auth attempt in case the cookie's session has expired and we need to get a new one
    if (isRetryAttempt && _.get(authResponse, 'result.statusCode') === 401) {
      let authErrorMessage = _.get(authResponse, 'result.body.mesg');
      throw new AuthRequestError(
        `Authentication Error: Unable to authenticate with Vertex. ${authErrorMessage}`
      );
    }
    session = authResponse.result.headers['set-cookie'];
    cookieCache.set(cookieCacheKey, session);
    polarityRequest.setHeaders('Cookie', session);
  } catch (err) {
    Logger.error({ err }, 'Failed to authenticate');
    throw err;
  }
}

async function sendRequests(entities, options) {
  return await Promise.all(
    _.map(entities, (entity) => {
      return polarityRequest.send({
        entity,
        method: 'GET',
        url: `${options.url}/api/v1/storm`,
        body: {
          query: getQuery(entity),
          stream: 'jsonlines',
          opts: { limit: 10 }
        }
      });
    })
  );
}

function getQuery(entity) {
  return `inet:${convertTypes(entity.type)} = ${entity.value}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function auth(options, retryCount = 0) {
  const Logger = getLogger();
  try {
    const authResponse = await polarityRequest.send({
      method: 'POST',
      url: `${options.url}/api/v1/optic/login`,
      body: {
        user: options.username,
        passwd: options.password
      }
    });

    Logger.trace({ authResponse }, 'Auth Response');

    return authResponse[0];
  } catch (err) {
    if (retryCount < 3) {
      Logger.trace({ err }, `${err.message} Retrying...${retryCount + 1}}`);
      await delay(1000);
      return auth(options, retryCount + 1);
    } else {
      throw new AuthRequestError(
        'Authentication Error: Unable to authenticate with Vertex. Please check your credentials and try again.'
      );
    }
  }
}

function buildResultObject(result, options) {
  const newDetails = {
    ...result.props,
    entity: result.entity,
    created: result.props['.created'],
    seen: result.props['.seen'],
    dns_rev: result.props['dns:rev'],
    nodeCount: result.nodeCount,
    queryLink: `${
      options.url
    }/research?stormmode=storm&displaymode=table&query=${encodeURIComponent(
      getQuery(result.entity)
    )}`
  };

  return newDetails;
}

function processApiResponse(nestedResponsesArray) {
  const Logger = getLogger();
  let allPropsData = [];

  nestedResponsesArray.forEach((responseArray) => {
    let count = 0;

    responseArray.forEach((response) => {
      if (response && response.result) {
        const jsonStrings = response.result.body.trim().split('\n');

        const propsData = jsonStrings
          .map((jsonString) => {
            try {
              const parsedObject = JSON.parse(jsonString);

              if (
                Array.isArray(parsedObject) &&
                parsedObject[0] === 'node' &&
                Array.isArray(parsedObject[1])
              ) {
                const nodeData = parsedObject[1];

                if (nodeData.length >= 2 && nodeData[1].hasOwnProperty('props')) {
                  count += 1;

                  return {
                    props: nodeData[1].props,
                    entity: response.entity,
                    nodeCount: count
                  };
                }
              }
            } catch (error) {
              Logger.error({ error }, 'Error Parsing JSON');
            }
            return undefined;
          })
          .filter(Boolean);

        if (propsData.length === 0) {
          allPropsData.push({
            entity: response.entity,
            isMiss: true
          });
        } else {
          allPropsData = allPropsData.concat(propsData);
        }
      } else {
        Logger.error('Response or response.result.body is not in the expected format.');
      }
    });
  });

  return allPropsData;
}

function validateOptions(userOptions, cb) {
  const requiredFields = [
    { key: 'url', message: 'You must provide a valid URL' },
    { key: 'username', message: 'You must provide a valid Vertex API Key' },
    { key: 'password', message: 'You must provide a valid Vertex API Key' }
  ];

  const errors = requiredFields.reduce((acc, { key, message }) => {
    if (
      typeof userOptions[key].value !== 'string' ||
      userOptions[key].value.length === 0
    ) {
      acc.push({ key, message });
    }
    return acc;
  }, []);

  return cb(null, errors);
}

function convertTypes(type) {
  switch (type) {
    case 'IPv4':
      return 'ipv4';
    case 'IPv6':
      return 'ipv6';
    case 'domain':
      return 'fqdn';
    case 'email':
      return 'email';
    default:
      return type;
  }
}

module.exports = {
  doLookup,
  validateOptions,
  startup
};
