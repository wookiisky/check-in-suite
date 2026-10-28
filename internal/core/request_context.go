package core

import "context"

// requestIDKey prevents unrelated context values from replacing the server-generated request identity.
type requestIDKey struct{}

// WithRequestID carries an HTTP request identity through ordinary service calls.
func WithRequestID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, requestIDKey{}, id)
}

// RequestID is empty for maintenance and background operations with no HTTP request.
func RequestID(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey{}).(string)
	return id
}
