function errorHandler(error, request, response, next) {
  const statusCode = error.statusCode || 500;
  const message = error.expose ? error.message : "Internal server error";
  const logLevel = statusCode >= 500 ? "error" : "warn";

  request.log[logLevel]({ err: error }, "Request failed");
  response.status(statusCode).json({ error: message });
}

module.exports = { errorHandler };
